// LLM features (study notes + Q&A) over a meeting transcript, via the OpenAI chat completions API.
import { User } from '../models/User.js';
import { decrypt } from '../utils/crypto.js';
import { HttpError } from '../utils/http.js';

const BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_MODEL = 'gpt-4o-mini';

// ~50k tokens. Transcripts longer than this are summarized in parts, and Q&A only sends the
// parts most relevant to the question, so smaller-context models still work.
const MAX_CONTEXT_CHARS = 200_000;
const CHUNK_CHARS = 120_000;
const HISTORY_TURNS = 8;
const TIMEOUT_MS = 180_000;

const pad = (n) => String(n).padStart(2, '0');
const clock = (ms = 0) => {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(t % 60)}` : `${pad(m)}:${pad(t % 60)}`;
};

const lineOf = (s) => `[${clock(s.startMs)}] ${s.speaker}: ${s.text}`;

/** The user's model and decrypted OpenAI key. Throws a helpful 400 if AI isn't set up. */
export async function loadAiSettings(userId, overrides = {}) {
  const user = await User.findById(userId).select('+ai.apiKeyEnc name');
  const apiKey = overrides.apiKey || (user?.ai?.apiKeyEnc && decrypt(user.ai.apiKeyEnc));
  if (!apiKey) throw new HttpError(400, 'Add your OpenAI API key in Settings to use AI features.');
  const model = overrides.model || user?.ai?.model || DEFAULT_MODEL;
  return { model, apiKey, userName: user?.name };
}

export async function chatCompletion({ model, apiKey }, messages) {
  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new HttpError(504, 'OpenAI took too long to respond. Try again.');
    throw new HttpError(502, `Could not reach OpenAI: ${err.cause?.code || err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.error?.message || data?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new HttpError(400, `OpenAI rejected the API key: ${detail}`);
    if (res.status === 429) throw new HttpError(429, `OpenAI: ${detail}`);
    throw new HttpError(502, `OpenAI error (model "${model}"): ${detail}`);
  }
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new HttpError(502, `OpenAI returned an empty answer (model "${model}").`);
  }
  return text.trim();
}

/** Split transcript lines into chunks of at most `size` characters. */
function chunkLines(lines, size) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length > size && cur.length) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(line);
    len += line.length + 1;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

const context = (meeting, userName) =>
  [
    `Title: ${meeting.title}`,
    `Date: ${new Date(meeting.startedAt || meeting.createdAt).toDateString()}`,
    `Duration: ${clock(meeting.durationMs)}`,
    'Transcript lines look like "[mm:ss] Speaker: text" (or [h:mm:ss]).',
    userName
      ? `"${userName}" is the person who recorded this (the student / user). "Others" is everyone else in the call — usually the teacher or presenter.`
      : '',
    'The transcript comes from automatic speech recognition, so expect misheard words; infer the intended technical terms from context.',
    meeting.notes?.trim() ? `The user's own notes:\n${meeting.notes.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');

const NOTES_FORMAT = `Write in Markdown using exactly these sections (omit a section only if there is truly nothing for it):
## Summary
3–6 sentences: what the session covered and the main takeaways.
## Key concepts
Bullet points; each concept with a short, clear explanation in your own words.
## Definitions & formulas
Bullet points. Write formulas in plain text / Unicode (e.g. "σ(z) = 1 / (1 + e^(−z))"), never LaTeX.
## Examples discussed
## Action items & deadlines
Assignments, exams, readings, submissions, things to prepare — with dates if mentioned.
## Questions to review
3–6 questions a student should be able to answer after this session.

Rules: cite the moment something was said with its timestamp in square brackets, e.g. [12:34] or [1:02:10], copied exactly from the transcript. Only state what the transcript supports; do not invent content. Be concise and well organized.`;

export async function summarize(meeting, settings) {
  const lines = meeting.segments.map(lineOf);
  if (!lines.length) throw new HttpError(400, 'This meeting has no transcript to summarize.');
  const system = `You turn lecture and meeting transcripts into clear study notes.\n${context(meeting, settings.userName)}`;
  const transcript = lines.join('\n');

  if (transcript.length <= MAX_CONTEXT_CHARS) {
    return chatCompletion(settings, [
      { role: 'system', content: system },
      { role: 'user', content: `${NOTES_FORMAT}\n\nTranscript:\n${transcript}` },
    ]);
  }

  // Long recording: take detailed notes per part, then merge them.
  const parts = chunkLines(lines, CHUNK_CHARS);
  const partNotes = [];
  for (const [i, part] of parts.entries()) {
    partNotes.push(
      await chatCompletion(settings, [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `This is part ${i + 1} of ${parts.length} of the transcript. Write detailed bullet-point notes of everything taught or decided in this part (concepts, definitions, formulas, examples, assignments, deadlines), keeping [timestamps].\n\nTranscript part ${i + 1}:\n${part.join('\n')}`,
        },
      ]),
    );
  }
  return chatCompletion(settings, [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `${NOTES_FORMAT}\n\nThe transcript was too long to send at once, so here are notes taken on each part in order. Combine them into one set of study notes.\n\n${partNotes.map((n, i) => `### Part ${i + 1}\n${n}`).join('\n\n')}`,
    },
  ]);
}

const words = (s) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);

/** Transcript text for Q&A: everything if it fits, otherwise the windows sharing the most words with the question. */
function transcriptFor(lines, question) {
  const full = lines.join('\n');
  if (full.length <= MAX_CONTEXT_CHARS) return full;
  const q = words(question);
  const windows = chunkLines(lines, 6_000).map((chunk, i) => {
    const w = words(chunk.join(' '));
    let score = 0;
    for (const t of q) if (w.has(t)) score += 1;
    return { i, chunk, score };
  });
  const picked = [];
  let len = 0;
  for (const win of [...windows].sort((a, b) => b.score - a.score || a.i - b.i)) {
    const size = win.chunk.join('\n').length;
    if (len + size > MAX_CONTEXT_CHARS) break;
    picked.push(win);
    len += size;
  }
  return `(Only the excerpts most relevant to the question are included.)\n${picked
    .sort((a, b) => a.i - b.i)
    .map((w) => w.chunk.join('\n'))
    .join('\n…\n')}`;
}

export async function answer(meeting, history, question, settings) {
  const lines = meeting.segments.map(lineOf);
  if (!lines.length) throw new HttpError(400, 'This meeting has no transcript to ask about.');
  const system = `You answer questions about one recorded lecture or meeting, using its transcript.
${context(meeting, settings.userName)}

Rules:
- Base answers on the transcript and cite timestamps in square brackets, e.g. [12:34], copied exactly from the transcript.
- If the transcript does not cover something, say so plainly. You may then add general background knowledge, clearly labelled as not from the session.
- When asked to explain a concept, explain it the way the presenter did, then clarify it simply if helpful.
- Use Markdown (short paragraphs, bullet lists). Write formulas in plain text / Unicode, never LaTeX.
${meeting.summary?.text ? `\nStudy notes previously generated for this session:\n${meeting.summary.text}\n` : ''}
Transcript:
${transcriptFor(lines, question)}`;

  return chatCompletion(settings, [
    { role: 'system', content: system },
    ...history.slice(-HISTORY_TURNS * 2).map(({ role, content }) => ({ role, content })),
    { role: 'user', content: question },
  ]);
}

/** Chat model ids available to this key, for the settings page. */
export async function listModels(apiKey) {
  const res = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res?.ok) return [];
  const data = await res.json().catch(() => ({}));
  const ids = (data.data || []).map((m) => m.id).filter(Boolean);
  // OpenAI also lists embedding, audio, image and moderation models; keep the chat ones.
  return ids
    .filter((id) => /^(gpt|o\d|chatgpt)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|instruct)/.test(id))
    .sort();
}
