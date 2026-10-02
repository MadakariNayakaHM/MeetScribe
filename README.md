# MeetScribe

A self-hosted MERN app that records meetings and transcribes them. You get a searchable, editable transcript that's synced to the audio.

There are two transcription engines:
1. **Live**, in the browser, while you record.
2. **Local Whisper** on the server, after you stop. It's more accurate, transcribes everyone (even when you're on headphones), and the audio never leaves your machine.

## Features

- **Live transcription** while you record. It uses the browser's Web Speech API, so there's no API key and no cost. Works in Chrome and Edge.
- **Audio recording.** Capture your mic alone (in-person meetings), or your mic plus a browser tab's audio (Meet / Zoom web / Teams).
- **Local Whisper transcription** using faster-whisper. It runs automatically after each recording, and you can re-run it from the meeting page. In online meetings, your mic and the tab are recorded as **separate tracks**, so lines are labelled **you** vs **Others** without any AI speaker detection.
- **Import** existing audio or video files (MP3, M4A, WAV, WebM, MP4…) and have them transcribed.
- **Nothing gets lost.** Transcript lines save to the server every few seconds. If the tab crashes, the meeting shows up as *Interrupted* and keeps everything up to that point. If an upload fails, you can retry it or download the audio locally.
- **Playback.** Click any line to jump to that moment. A "follow along" mode highlights the line being played.
- **Editing.** Fix any line (double-click it). Rename a speaker everywhere at once. Delete lines. ★ Highlight key moments, either live while recording or afterwards.
- **Organization.** Notes, tags, and full-text search across titles, notes, tags and transcripts.
- **Insights.** Word count, plus talk-time share per speaker.
- **Export** as Markdown, TXT, SRT, VTT or JSON, or download the audio.
- **Accounts.** Login with JWT auth. Each user can only see their own meetings.
- Pause and resume, a mic level meter, 23 languages, and dark mode.

## Quick start (development)

Requirements: Node 20+, Docker (for MongoDB) or your own MongoDB.

```bash
npm run install:all          # install root, server and client deps
npm run setup:whisper        # optional: Python venv + faster-whisper (needs Python 3.10+)
cp server/.env.example server/.env   # then set JWT_SECRET
npm run db                   # MongoDB on localhost:27018 (docker compose)
npm run dev                  # API on :5050, web on :5173
```

Open http://localhost:5173 in **Chrome or Edge**, create an account, and click **New recording**.

If Whisper is installed, the server log says `Whisper: ready`. The first transcription downloads the model (~500 MB for `small`) into `server/worker/models/`.

## Production

**Option 1: a single Node process.** Express serves the built React app:

```bash
npm run build
NODE_ENV=production npm start      # http://localhost:5050
```

**Option 2: Docker.** Runs the app and MongoDB together:

```bash
JWT_SECRET=$(openssl rand -hex 48) docker compose --profile prod up -d --build
```

Microphone access only works on a secure origin: put the app behind HTTPS (Caddy, nginx, etc.) when it isn't on `localhost`.

## How transcription works

```
Browser                                         Server
──────────────────────────────────────          ─────────────────────────────────────
mic ─┬─► mix ──► recording.webm (playback) ──►  uploads/
tab ─┤                                          │
     └─► stereo L=mic R=tab ─► tracks.webm ──►  │  job queue (MongoDB status, 1 at a time)
mic ───► Web Speech API ─► live lines ──────►   │  └─► python worker/transcribe.py
                            (saved every 4s)    │        Silero VAD → faster-whisper per channel
                                                │        → "<your name>" / "Others", echo removed
                                                └─► replaces the live transcript (keeps ★ highlights)
```

- **During the meeting** you see the live browser transcript. It only hears your microphone.
- **After you stop**, the server queues a Whisper job. The meeting page shows its progress, and transcript editing is paused until the job finishes or you cancel it.
- **With headphones** (online meeting, "Microphone + browser tab"), Whisper transcribes the mic track as you and the tab track as **Others**. If you use speakers and the mic picks up the others too, those duplicate lines are detected and dropped.
- **In-person meetings** (mic only) produce a single track, so everything is labelled `Speaker 1`. Rename speakers on the meeting page.
- **If Whisper finds no speech**, it keeps the live transcript instead of replacing it.

**Speed.** On an 8-core CPU, the `small` model processes audio about **4× faster than realtime**: a 1-hour mic-only meeting takes about 15 minutes. With separate tracks, each track is processed, but silence is skipped. For more speed, use `WHISPER_MODEL=base`; for more accuracy, use `medium` or `large-v3`, ideally on a GPU (`WHISPER_DEVICE=cuda`, `WHISPER_COMPUTE_TYPE=float16`).

**Online meetings:** choose **Microphone + browser tab**, then pick the meeting tab and turn on **"Also share tab audio"**. Desktop Zoom/Teams apps can't be captured this way. Join from the browser, or import their recording afterwards.

## Configuration (`server/.env`)

| Var | Default | |
|---|---|---|
| `PORT` | `5050` | API port |
| `MONGO_URI` | `mongodb://127.0.0.1:27018/meetscribe` | |
| `JWT_SECRET` | — | **Required in production** |
| `JWT_EXPIRES_IN` | `7d` | |
| `CLIENT_ORIGIN` | `http://localhost:5173` | CORS origin |
| `UPLOAD_DIR` | `uploads` | Where audio files are stored |
| `MAX_UPLOAD_MB` | `500` | |
| `WHISPER_ENABLED` | `true` | Set `false` to turn server transcription off |
| `WHISPER_AUTO` | `true` | Transcribe automatically after recording/import |
| `WHISPER_MODEL` | `small` | `tiny`, `base`, `small`, `medium`, `large-v3`, `distil-large-v3` |
| `WHISPER_DEVICE` | `auto` | `cpu` / `cuda` |
| `WHISPER_COMPUTE_TYPE` | `int8` | `float16` on GPU |
| `WHISPER_THREADS` | `0` (auto) | CPU threads |

## Project layout

```
server/src
  index.js            Express app, error handling, serves client/dist in prod
  models/             User, Meeting (segments embedded; `summary` reserved for AI)
  routes/auth.js      register / login / me
  routes/meetings.js  CRUD, segments, speaker rename, audio upload, export
  routes/media.js     audio streaming (HTTP Range) via short-lived media token
  services/transcription.js  Whisper job queue (persisted in MongoDB, survives restarts)
server/worker
  transcribe.py       faster-whisper worker: VAD clips, per-channel speakers, echo removal
client/src
  lib/recording.js    mic/tab capture + mixing, MediaRecorder, speech recognition
  pages/Recorder.jsx  live recording UI
  pages/MeetingPage.jsx  playback, editing, notes, speakers, export
  pages/Dashboard.jsx    list + search
```

## API

All routes need `Authorization: Bearer <token>`, except auth and media.

| Method | Path | |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login` | → `{ token, user }` |
| GET | `/api/meetings?q=&page=` | List and search |
| POST | `/api/meetings` | Create |
| GET / PATCH / DELETE | `/api/meetings/:id` | Read, update (title, notes, tags, status…), delete |
| POST | `/api/meetings/:id/segments` | Append transcript lines `{ segments: [...] }` |
| PATCH / DELETE | `/api/meetings/:id/segments/:segId` | Edit or delete a line |
| PATCH | `/api/meetings/:id/speakers` | `{ from, to }`: rename a speaker everywhere |
| POST | `/api/meetings/:id/audio` | Multipart: `audio` (playback) + optional `tracks` (stereo mic/tab). Queues Whisper unless `?transcribe=false` |
| POST / DELETE | `/api/meetings/:id/transcribe` | Start or cancel a Whisper job |
| GET | `/api/config` | `{ whisper: { available, model } }` |
| GET | `/api/meetings/:id/audio-url` | Signed streaming URL |
| GET | `/api/meetings/:id/export?format=md\|txt\|srt\|vtt\|json` | Download |

## Features to be built

### 1. Speaker names from the meeting app (next up)

**Goal:** split the "Others" track into real participant names for online meetings, without voice training or AI speaker detection.

**How:** Meet, Zoom web and Teams highlight whoever is speaking, and show their name. A small **Chrome extension** watches that indicator during the call and logs speaking turns. The server then uses those turns to set the speaker of each Whisper line.

```
Meet tab ──(extension: active-speaker events)──► MeetScribe recorder ──► POST /api/meetings/:id/speaker-events
                                                                                  │
Whisper "Others" lines  ◄── each line gets the name that was speaking the longest ┘
                            during its time range
```

**Plan:**
- **Extension** (Manifest V3, content script per platform):
  - Detect the active speaker from the call page: Meet's speaking-tile indicator, Zoom web's active-speaker view, Teams' speaking ring.
  - Emit `{ name, startMs, endMs }`, debounced so a speaker must hold the floor about 300 ms to count.
  - Send events to the MeetScribe tab with `chrome.runtime` messaging.
  - Read the participant list for display names.
- **Recorder:**
  - Show "Connected to Google Meet ✓" when the extension is detected.
  - Timestamp events on the recording clock, subtracting pauses.
  - Batch-save events with the transcript lines.
- **Server:**
  - Add a `speakerEvents` array to `Meeting`.
  - After Whisper finishes, label each line from the **Others** track with the name that spoke the longest during that line. Your own mic track stays as you.
  - Lines with no matching events stay "Others".
  - Split a line when the active speaker changes mid-line (needs word timestamps from the worker).
- **Re-apply** the names when the meeting is re-transcribed.

**Limitations:**
- Platform page structures change without notice, so the detectors need maintenance. Keep them in one small file per platform, with a fallback to "Others".
- Speaking-indicator latency is roughly 200–500 ms, so very short interjections may be attributed to the previous speaker.
- Desktop apps (Zoom/Teams clients) are not covered; this only works for browser calls.
- When people talk over each other, the platform highlights only one of them.

### 2. Faster speaker corrections
- Click a speaker label to reassign that line.
- Select several lines and set their speaker in one go.
- Merge two speakers into one.

### 3. Speaker diarization (in-person meetings)
Tell voices apart on a single-mic recording with pyannote or sherpa-onnx in the worker. An optional "number of speakers" field would improve accuracy. Benchmark both on CPU before choosing.

### 4. Voice profiles
Save a voice fingerprint when a speaker is named, and auto-label that person in later meetings.

### 5. AI features
- **Summaries and action items.** Add a `POST /api/meetings/:id/summary` route that sends the transcript to an LLM and stores the result in the existing `meeting.summary` field. It could run automatically when the Whisper job finishes.
- **Ask questions across your meetings.** Embed the segments and add a chat endpoint.
