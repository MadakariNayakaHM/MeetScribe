import { useEffect, useRef, useState } from 'react';
import { useBlocker, useNavigate } from 'react-router-dom';
import fixWebmDuration from 'fix-webm-duration';
import { api, saveBlob, uploadAudio } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useServerConfig } from '../lib/useServerConfig.js';
import { LANGUAGES, clock, defaultTitle } from '../lib/format.js';
import {
  SpeechRecognition, captureAudio, createTranscriber, describeMediaError, extensionFor, startRecorder,
} from '../lib/recording.js';

const FLUSH_INTERVAL_MS = 4000;
const LANG_KEY = 'meetscribe.lang';
const canShareTabAudio = Boolean(navigator.mediaDevices?.getDisplayMedia);

const capitalize = (t) => t.charAt(0).toUpperCase() + t.slice(1);

// MediaRecorder WebM files lack a duration header, which breaks seeking. Patch it in.
const withDuration = (blob, ms) =>
  blob.type.includes('webm') ? fixWebmDuration(blob, ms, { logger: false }).catch(() => blob) : Promise.resolve(blob);

export default function Recorder() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { whisper } = useServerConfig();
  const [title, setTitle] = useState(defaultTitle);
  const [lang, setLang] = useState(() => localStorage.getItem(LANG_KEY) || navigator.language || 'en-US');
  const [includeTabAudio, setIncludeTabAudio] = useState(false);
  const [speaker, setSpeaker] = useState('Speaker 1');
  const [phase, setPhase] = useState('setup'); // setup | starting | recording | paused | finishing | failed
  const [lines, setLines] = useState([]);
  const [interim, setInterim] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [progress, setProgress] = useState('');

  const s = useRef(null); // mutable session state (not rendered)
  const speakerRef = useRef(speaker);
  speakerRef.current = speaker;
  const meterRef = useRef(null);
  const transcriptEnd = useRef(null);

  const live = phase === 'recording' || phase === 'paused';
  const blockNav = useRef(false);
  const blocker = useBlocker(() => blockNav.current);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [lines.length, interim]);

  useEffect(() => {
    if (!live && phase !== 'finishing') return;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [live, phase]);

  // Release devices if the component unmounts mid-session.
  useEffect(() => () => teardown(), []);

  function elapsedMs() {
    const x = s.current;
    if (!x) return 0;
    const now = performance.now();
    return Math.max(0, Math.round(now - x.startedAt - x.pausedTotal - (x.pausedAt ? now - x.pausedAt : 0)));
  }

  function teardown() {
    const x = s.current;
    if (!x) return;
    clearInterval(x.tick);
    clearInterval(x.flushTimer);
    cancelAnimationFrame(x.raf);
    x.transcriber?.stop();
    x.recorder?.stop();
    x.tracksRecorder?.stop();
    x.capture?.stop();
    x.ctx?.close().catch(() => {});
  }

  function addLine(text) {
    const x = s.current;
    const endMs = elapsedMs();
    const words = text.split(/\s+/).length;
    const startMs = x.phraseStart ?? Math.max(0, endMs - words * 400);
    x.phraseStart = null;
    const line = {
      key: crypto.randomUUID(),
      startMs: Math.min(startMs, endMs),
      endMs,
      text: capitalize(text),
      speaker: speakerRef.current.trim() || 'Speaker 1',
    };
    x.pending.push(line);
    setLines((prev) => [...prev, line]);
  }

  async function flush() {
    const x = s.current;
    if (!x || x.flushing || !x.pending.length) return;
    x.flushing = true;
    const batch = x.pending.splice(0);
    try {
      const { segments } = await api.post(`/meetings/${x.meetingId}/segments`, {
        segments: batch.map(({ key, ...seg }) => ({ ...seg, highlighted: Boolean(x.hl[key]) })),
      });
      // Server returns segments in the same order they were sent.
      batch.forEach((line, i) => {
        const id = segments[i]?._id;
        x.serverIds[line.key] = id;
        // Highlight toggled while this batch was in flight.
        if (id && Boolean(x.hl[line.key]) !== segments[i].highlighted) {
          api.patch(`/meetings/${x.meetingId}/segments/${id}`, { highlighted: Boolean(x.hl[line.key]) }).catch(() => {});
        }
      });
    } catch {
      x.pending.unshift(...batch); // retry on next tick
    } finally {
      x.flushing = false;
    }
  }

  function startMeter(analyser) {
    const data = new Uint8Array(analyser.fftSize);
    const loop = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      const level = Math.min(1, Math.sqrt(sum / data.length) * 4);
      if (meterRef.current) meterRef.current.style.transform = `scaleX(${level.toFixed(3)})`;
      s.current.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  async function start() {
    setError('');
    setWarning('');
    // Create the AudioContext inside the click gesture so it isn't suspended.
    const ctx = new AudioContext();
    s.current = { ctx, pending: [], serverIds: {}, hl: {}, pausedTotal: 0, pausedAt: null, phraseStart: null };
    setPhase('starting');

    let capture;
    try {
      capture = await captureAudio(ctx, {
        includeTabAudio,
        onTabAudioEnded: () => setWarning('Tab/screen sharing stopped — only your microphone is being recorded now.'),
      });
    } catch (err) {
      ctx.close().catch(() => {});
      s.current = null;
      setPhase('setup');
      setError(describeMediaError(err));
      return;
    }
    if (includeTabAudio && !capture.tabAudio) {
      setWarning('No tab audio was shared. To capture other participants, pick a browser tab and tick “Share tab audio”.');
    }

    let meeting;
    try {
      ({ meeting } = await api.post('/meetings', { title: title.trim() || defaultTitle(), language: lang, startedAt: new Date() }));
    } catch (err) {
      capture.stop();
      ctx.close().catch(() => {});
      s.current = null;
      setPhase('setup');
      setError(err.message);
      return;
    }
    localStorage.setItem(LANG_KEY, lang);

    const x = s.current;
    x.capture = capture;
    x.meetingId = meeting._id;
    await ctx.resume().catch(() => {});

    x.recorder = startRecorder(capture.stream, 48000);
    if (capture.tracksStream) {
      x.tracksRecorder = startRecorder(capture.tracksStream, 64000);
      // With tab audio, the live transcript only hears the mic — i.e. you.
      setSpeaker(user.name);
    }
    x.startedAt = performance.now();

    x.transcriber = createTranscriber({
      lang,
      onFinal: addLine,
      onInterim: (text) => {
        if (text && x.phraseStart == null) x.phraseStart = Math.max(0, elapsedMs() - 600);
        setInterim(text);
      },
      onError: (msg) => setWarning(msg),
    });
    if (!x.transcriber) {
      setWarning('Live transcription needs Chrome or Edge. Audio is still being recorded and saved.');
    } else {
      x.transcriber.start();
    }

    x.tick = setInterval(() => setElapsed(elapsedMs()), 250);
    x.flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
    startMeter(capture.analyser);
    blockNav.current = true;
    setPhase('recording');
  }

  function pause() {
    const x = s.current;
    x.recorder.pause();
    x.tracksRecorder?.pause();
    x.pausedAt = performance.now();
    x.transcriber?.stop();
    setPhase('paused');
  }

  function resume() {
    const x = s.current;
    x.pausedTotal += performance.now() - x.pausedAt;
    x.pausedAt = null;
    x.recorder.resume();
    x.tracksRecorder?.resume();
    x.transcriber?.start();
    setPhase('recording');
  }

  async function highlightLast() {
    const x = s.current;
    const last = lines[lines.length - 1];
    if (!last) return;
    const highlighted = !x.hl[last.key];
    x.hl[last.key] = highlighted;
    setLines((prev) => prev.map((l) => (l.key === last.key ? { ...l, highlighted } : l)));
    const id = x.serverIds[last.key];
    if (id) api.patch(`/meetings/${x.meetingId}/segments/${id}`, { highlighted }).catch(() => {});
  }

  async function stop() {
    const x = s.current;
    setPhase('finishing');
    setProgress('Finishing transcription…');
    if (x.pausedAt) { x.pausedTotal += performance.now() - x.pausedAt; x.pausedAt = null; }
    const durationMs = elapsedMs();
    clearInterval(x.tick);
    clearInterval(x.flushTimer);
    cancelAnimationFrame(x.raf);

    const [audio, tracks] = await Promise.all([
      x.recorder.stop(),
      x.tracksRecorder?.stop(),
      x.transcriber?.stop(),
    ]);
    x.capture.stop();
    x.ctx.close().catch(() => {});

    x.final = {
      audio: await withDuration(audio, durationMs),
      tracks: tracks?.size ? await withDuration(tracks, durationMs) : null,
      durationMs,
    };
    await finalize();
  }

  async function finalize() {
    const x = s.current;
    const { audio, tracks, durationMs } = x.final;
    setPhase('finishing');
    setError('');
    try {
      setProgress('Saving transcript…');
      for (let i = 0; i < 5 && x.pending.length; i++) await flush();
      if (x.pending.length) throw new Error('Could not save the transcript.');

      if (audio.size > 0 && !x.audioUploaded) {
        setProgress('Uploading audio… 0%');
        await uploadAudio(x.meetingId, { audio, tracks }, (p) =>
          setProgress(`Uploading audio… ${Math.round(p * 100)}%`),
        );
        x.audioUploaded = true;
      }
      await api.patch(`/meetings/${x.meetingId}`, { status: 'completed', durationMs, endedAt: new Date() });
      blockNav.current = false;
      setPhase('done');
      navigate(`/meetings/${x.meetingId}`, { replace: true });
    } catch (err) {
      setPhase('failed');
      setError(`${err.message} Your recording is still in this tab — retry, or download it so nothing is lost.`);
    }
  }

  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
    return (
      <div className="card empty">
        <h2>Recording isn’t supported here</h2>
        <p className="muted">Use a recent version of Chrome or Edge, served over HTTPS or localhost.</p>
      </div>
    );
  }

  return (
    <div className="recorder">
      {blocker.state === 'blocked' && (
        <div className="modal-backdrop">
          <div className="card modal">
            <h3>Recording in progress</h3>
            <p className="muted">Leaving now will stop the recording and the audio will be lost. The transcript so far is saved.</p>
            <div className="row-end">
              <button className="btn" onClick={() => blocker.reset()}>Stay</button>
              <button className="btn btn-danger" onClick={() => { blockNav.current = false; teardown(); blocker.proceed(); }}>Leave anyway</button>
            </div>
          </div>
        </div>
      )}

      {phase === 'setup' || phase === 'starting' ? (
        <div className="card setup">
          <h1>New recording</h1>
          <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></label>
          <div className="grid-2">
            <label>
              Spoken language
              <select value={lang} onChange={(e) => setLang(e.target.value)}>
                {!LANGUAGES.some(([code]) => code === lang) && <option value={lang}>{lang}</option>}
                {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </label>
            <label>
              Audio source
              <select value={includeTabAudio ? 'tab' : 'mic'} onChange={(e) => setIncludeTabAudio(e.target.value === 'tab')}>
                <option value="mic">Microphone only (in-person meeting)</option>
                {canShareTabAudio && <option value="tab">Microphone + browser tab (online meeting)</option>}
              </select>
            </label>
          </div>
          {includeTabAudio && (
            <p className="hint">
              You’ll be asked to share a tab — pick your Meet/Zoom/Teams tab and enable <b>“Also share tab audio”</b>.{' '}
              {whisper.available ? (
                <>
                  Your mic and the tab are recorded as separate tracks. The live transcript only hears your mic, but when
                  you stop, local Whisper transcribes both tracks — labelled <b>{user.name}</b> and <b>Others</b>.
                  Headphones work fine.
                </>
              ) : (
                <>
                  Everyone is captured in the audio, but live transcription only hears your microphone — with headphones,
                  only your side will be transcribed. Install local Whisper on the server to transcribe everyone.
                </>
              )}
            </p>
          )}
          {!SpeechRecognition && (
            <div className="alert alert-warn">
              Live transcription requires Chrome or Edge. In this browser, only audio will be recorded
              {whisper.available ? ' — Whisper will transcribe it after you stop.' : '.'}
            </div>
          )}
          {error && <div className="alert alert-error">{error}</div>}
          <button className="btn btn-primary btn-lg" onClick={start} disabled={phase === 'starting'}>
            {phase === 'starting' ? 'Starting…' : '● Start recording'}
          </button>
        </div>
      ) : (
        <>
          <div className="card rec-bar">
            <div className="rec-status">
              <span className={`rec-dot ${phase === 'recording' ? 'on' : ''}`} />
              <div>
                <div className="rec-title">{title}</div>
                <div className="rec-time">{clock(elapsed)} {phase === 'paused' && <span className="badge">Paused</span>}</div>
              </div>
            </div>
            <div className="meter"><div ref={meterRef} className="meter-fill" /></div>
            <div className="rec-controls">
              {live && (
                <>
                  <label className="speaker-input" title="New lines are attributed to this speaker">
                    <span>Speaker</span>
                    <input value={speaker} onChange={(e) => setSpeaker(e.target.value)} maxLength={60} />
                  </label>
                  <button className="btn" onClick={highlightLast} disabled={!lines.length} title="Highlight the last line">★ Highlight</button>
                  {phase === 'recording'
                    ? <button className="btn" onClick={pause}>❚❚ Pause</button>
                    : <button className="btn" onClick={resume}>▶ Resume</button>}
                  <button className="btn btn-danger" onClick={stop}>■ Stop &amp; save</button>
                </>
              )}
              {phase === 'finishing' && <span className="muted">{progress}</span>}
              {phase === 'failed' && (
                <>
                  <button className="btn btn-primary" onClick={finalize}>Retry save</button>
                  <button className="btn" onClick={() => saveBlob(s.current.final.audio, `${title || 'recording'}.${extensionFor(s.current.final.audio.type)}`)}>
                    Download audio
                  </button>
                </>
              )}
            </div>
          </div>

          {warning && <div className="alert alert-warn">{warning}</div>}
          {error && <div className="alert alert-error">{error}</div>}

          <div className="card transcript live-transcript">
            {lines.length === 0 && !interim && (
              <p className="muted center">{phase === 'paused' ? 'Paused.' : 'Listening… start speaking and the transcript will appear here.'}</p>
            )}
            {lines.map((l) => (
              <div key={l.key} className={`seg ${l.highlighted ? 'seg-hl' : ''}`}>
                <span className="seg-time">{clock(l.startMs)}</span>
                <div className="seg-body">
                  <span className="seg-speaker">{l.speaker}</span>
                  <p>{l.text}</p>
                </div>
              </div>
            ))}
            {interim && (
              <div className="seg seg-interim">
                <span className="seg-time">{clock(elapsed)}</span>
                <div className="seg-body">
                  <span className="seg-speaker">{speaker}</span>
                  <p>{interim}</p>
                </div>
              </div>
            )}
            <div ref={transcriptEnd} />
          </div>
        </>
      )}
    </div>
  );
}
