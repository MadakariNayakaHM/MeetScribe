// Local Whisper transcription queue. Jobs live in MongoDB (meeting.transcription.status),
// so they survive restarts. One job runs at a time in a Python subprocess (worker/transcribe.py).
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import mongoose from 'mongoose';
import { Meeting } from '../models/Meeting.js';
import { User } from '../models/User.js';
import { config } from '../config.js';

const { whisper } = config;
const ACTIVE = ['queued', 'processing'];

let available = false;
let running = null; // { meetingId, child, cancelled }
let busy = false;
let again = false;

export const whisperStatus = () => ({ available, model: whisper.model, auto: whisper.autoTranscribe });
export const isActive = (status) => ACTIVE.includes(status);

export async function initTranscription() {
  if (!whisper.enabled) return console.log('Whisper: disabled (WHISPER_ENABLED=false)');
  available = await new Promise((resolve) =>
    execFile(whisper.python, ['-c', 'import faster_whisper'], { timeout: 60000 }, (err) => resolve(!err)),
  );
  if (!available) {
    return console.warn(`Whisper: not available (${whisper.python} cannot import faster_whisper). Run "npm run setup:whisper". Live browser transcripts still work.`);
  }
  console.log(`Whisper: ready (model "${whisper.model}", ${whisper.device})`);
  // Jobs that were mid-flight when the server stopped go back in the queue.
  await Meeting.updateMany(
    { 'transcription.status': 'processing' },
    { $set: { 'transcription.status': 'queued', 'transcription.progress': 0 } },
  );
  kick();
}

/** Queue a meeting for transcription. Returns false if it is already queued/processing or has no audio. */
export async function enqueue(meetingId) {
  const res = await Meeting.updateOne(
    { _id: meetingId, 'audio.filename': { $exists: true }, 'transcription.status': { $nin: ACTIVE } },
    {
      $set: {
        'transcription.status': 'queued',
        'transcription.progress': 0,
        'transcription.queuedAt': new Date(),
        'transcription.model': whisper.model,
        'transcription.error': null,
      },
    },
  );
  kick();
  return res.modifiedCount > 0;
}

/** Stop a queued or running job. The existing transcript is kept. */
export async function cancel(meetingId) {
  if (running?.meetingId === String(meetingId)) {
    running.cancelled = true;
    running.child.kill('SIGTERM');
  }
  await Meeting.updateOne(
    { _id: meetingId, 'transcription.status': { $in: ACTIVE } },
    { $set: { 'transcription.status': 'none', 'transcription.progress': 0 } },
  );
}

function kick() {
  again = true;
  if (busy || !available) return;
  busy = true;
  (async () => {
    try {
      while (again) {
        again = false;
        let job;
        while ((job = await claimNext())) await runJob(job);
      }
    } catch (err) {
      console.error('Whisper queue error:', err);
    } finally {
      busy = false;
    }
  })();
}

const claimNext = () =>
  Meeting.findOneAndUpdate(
    { 'transcription.status': 'queued' },
    { $set: { 'transcription.status': 'processing', 'transcription.startedAt': new Date(), 'transcription.progress': 0 } },
    { sort: { 'transcription.queuedAt': 1 }, returnDocument: 'after' },
  );

// "en-US" -> "en"; "auto" or empty -> let Whisper detect.
const whisperLanguage = (lang) => (!lang || lang === 'auto' ? null : lang.split('-')[0].toLowerCase());

async function runJob(meeting) {
  const id = String(meeting._id);
  const useTracks = Boolean(meeting.tracks?.filename);
  let labels;
  if (useTracks) {
    const user = await User.findById(meeting.user, { name: 1 });
    labels = [user?.name || 'Me', 'Others'];
  } else {
    const speakers = [...new Set(meeting.segments.map((s) => s.speaker))];
    labels = [speakers.length === 1 ? speakers[0] : 'Speaker 1'];
  }

  const args = [
    whisper.script,
    '--input', path.join(config.uploadDir, useTracks ? meeting.tracks.filename : meeting.audio.filename),
    '--labels', labels.map((l) => l.replaceAll(',', ' ')).join(','),
    '--model', whisper.model,
    '--device', whisper.device,
    '--compute-type', whisper.computeType,
    '--threads', String(whisper.threads),
    '--model-dir', whisper.modelDir,
  ];
  if (useTracks) args.push('--stereo-tracks');
  const lang = whisperLanguage(meeting.language);
  if (lang) args.push('--language', lang);

  console.log(`Whisper: transcribing ${id}${useTracks ? ' (separate tracks)' : ''}`);
  const started = Date.now();
  const child = spawn(whisper.python, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  running = { meetingId: id, child, cancelled: false };

  let result = null;
  let duration = 0;
  let stderr = '';
  let lastProgressWrite = 0;
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'info') duration = msg.duration;
    if (msg.type === 'result') result = msg;
    if (msg.type === 'progress' && Date.now() - lastProgressWrite > 1500) {
      lastProgressWrite = Date.now();
      Meeting.updateOne(
        { _id: id, 'transcription.status': 'processing' },
        { $set: { 'transcription.progress': msg.value } },
      ).catch(() => {});
    }
  });

  const code = await new Promise((resolve) => {
    child.on('error', (err) => { stderr += err.message; resolve(-1); });
    child.on('close', resolve);
  });
  const { cancelled } = running;
  running = null;
  if (cancelled) return console.log(`Whisper: cancelled ${id}`);

  if (code !== 0 || !result) {
    const raw = stderr.trim().split('\n').filter((l) => !l.startsWith('Warning')).at(-1) || `Worker exited with code ${code}`;
    const error = /InvalidDataError|Invalid data found|no audio stream/i.test(raw)
      ? 'The audio could not be decoded — the file may be corrupt or in an unsupported format.'
      : raw.replaceAll(config.uploadDir, '<uploads>');
    console.error(`Whisper: failed ${id}: ${error}`);
    await Meeting.updateOne(
      { _id: id },
      { $set: { 'transcription.status': 'failed', 'transcription.error': error.slice(0, 500), 'transcription.progress': 0 } },
    );
    return;
  }

  if (!result.segments.length && meeting.segments.length) {
    // Never replace a live transcript with nothing.
    await Meeting.updateOne(
      { _id: id },
      { $set: { 'transcription.status': 'failed', 'transcription.progress': 0, 'transcription.error': 'Whisper found no speech in the recording, so the live transcript was kept.' } },
    );
    return console.log(`Whisper: no speech found in ${id}; kept live transcript`);
  }

  const segments = result.segments.map((s) => ({ _id: new mongoose.Types.ObjectId(), highlighted: false, ...s }));
  carryOverHighlights(meeting.segments, segments);

  const $set = {
    segments,
    'transcription.status': 'done',
    'transcription.source': 'whisper',
    'transcription.progress': 1,
    'transcription.completedAt': new Date(),
  };
  if (!meeting.durationMs && duration) $set.durationMs = Math.round(duration * 1000);
  await Meeting.updateOne({ _id: id, 'transcription.status': 'processing' }, { $set });
  console.log(`Whisper: done ${id} — ${segments.length} lines in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

// Keep the user's ★ highlights: mark the new line that overlaps each old highlighted line the most.
function carryOverHighlights(oldSegments, newSegments) {
  for (const old of oldSegments.filter((s) => s.highlighted)) {
    let best = null;
    let bestOverlap = 0;
    for (const seg of newSegments) {
      const overlap = Math.min(old.endMs, seg.endMs) - Math.max(old.startMs, seg.startMs);
      if (overlap > bestOverlap) { best = seg; bestOverlap = overlap; }
    }
    if (!best) {
      best = newSegments.reduce((a, b) => (Math.abs(b.startMs - old.startMs) < Math.abs(a.startMs - old.startMs) ? b : a), newSegments[0]);
    }
    if (best) best.highlighted = true;
  }
}
