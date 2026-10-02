import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, uploadAudio } from '../lib/api.js';
import { LANGUAGES } from '../lib/format.js';

function readDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const media = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio');
    const done = (ms) => { URL.revokeObjectURL(url); resolve(ms); };
    media.preload = 'metadata';
    media.onloadedmetadata = () => done(Number.isFinite(media.duration) ? Math.round(media.duration * 1000) : 0);
    media.onerror = () => done(0);
    setTimeout(() => done(0), 5000);
    media.src = url;
  });
}

export default function ImportDialog({ whisperAvailable, onClose }) {
  const navigate = useNavigate();
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState('auto');
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');

  function pick(f) {
    setFile(f);
    if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));
  }

  async function submit(e) {
    e.preventDefault();
    if (!file) return;
    setError('');
    setProgress(0);
    try {
      const durationMs = await readDuration(file);
      const { meeting } = await api.post('/meetings', {
        title: title.trim() || file.name,
        language,
        startedAt: new Date(file.lastModified || Date.now()),
      });
      await uploadAudio(meeting._id, { audio: file }, setProgress);
      await api.patch(`/meetings/${meeting._id}`, { status: 'completed', durationMs });
      navigate(`/meetings/${meeting._id}`);
    } catch (err) {
      setProgress(null);
      setError(err.message);
    }
  }

  const busy = progress !== null;
  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="card modal" onSubmit={submit}>
        <h3>Import a recording</h3>
        <p className="muted small">
          {whisperAvailable
            ? 'Audio or video files (MP3, M4A, WAV, WebM, MP4…). Local Whisper will transcribe it on the server.'
            : 'Whisper is not installed on the server, so imported recordings can be played and annotated but not transcribed.'}
        </p>
        <input type="file" accept="audio/*,video/*" onChange={(e) => pick(e.target.files[0] || null)} required disabled={busy} />
        <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} disabled={busy} /></label>
        <label>
          Spoken language
          <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={busy}>
            <option value="auto">Auto-detect</option>
            {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </label>
        {error && <div className="alert alert-error">{error}</div>}
        {busy && <div className="bar"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
        <div className="row-end">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" disabled={!file || busy}>
            {busy ? `Uploading… ${Math.round(progress * 100)}%` : 'Import'}
          </button>
        </div>
      </form>
    </div>
  );
}
