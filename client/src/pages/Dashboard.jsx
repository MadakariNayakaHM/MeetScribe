import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { formatDate, humanDuration } from '../lib/format.js';
import Highlight from '../components/Highlight.jsx';
import ImportDialog from '../components/ImportDialog.jsx';
import { useServerConfig } from '../lib/useServerConfig.js';

const isTranscribing = (m) => ['queued', 'processing'].includes(m.transcription?.status);

export default function Dashboard() {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [data, setData] = useState({ items: [], total: 0, page: 1, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const { whisper } = useServerConfig();

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get(`/meetings?q=${encodeURIComponent(debounced)}&page=1`)
      .then((d) => !cancelled && (setData(d), setError('')))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [debounced]);

  // Refresh the list while any visible meeting is being transcribed.
  const anyTranscribing = data.items.some(isTranscribing);
  useEffect(() => {
    if (!anyTranscribing) return;
    const t = setInterval(async () => {
      try {
        const d = await api.get(`/meetings?q=${encodeURIComponent(debounced)}&page=1&limit=${Math.max(20, data.items.length)}`);
        setData((prev) => ({ ...prev, items: d.items, total: d.total }));
      } catch { /* ignore */ }
    }, 4000);
    return () => clearInterval(t);
  }, [anyTranscribing, debounced, data.items.length]);

  async function loadMore() {
    setLoading(true);
    try {
      const d = await api.get(`/meetings?q=${encodeURIComponent(debounced)}&page=${data.page + 1}`);
      setData((prev) => ({ ...d, items: [...prev.items, ...d.items] }));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Meetings</h1>
          <p className="muted">{data.total} {data.total === 1 ? 'meeting' : 'meetings'}{debounced && ` matching “${debounced}”`}</p>
        </div>
        <div className="row-end grow-search">
          <input className="search" type="search" placeholder="Search titles, notes, tags and transcripts…"
            value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn" onClick={() => setImporting(true)}>⤒ Import recording</button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {!loading && data.items.length === 0 && (
        <div className="card empty">
          {debounced ? (
            <p>No meetings match “{debounced}”.</p>
          ) : (
            <>
              <h2>No meetings yet</h2>
              <p className="muted">Record your first meeting and get a live, searchable transcript.</p>
              <Link to="/record" className="btn btn-primary">● Start recording</Link>
            </>
          )}
        </div>
      )}

      <div className="meeting-list">
        {data.items.map((m) => (
          <Link key={m._id} to={`/meetings/${m._id}`} className="card meeting-card">
            <div className="meeting-card-head">
              <h3>{m.title}</h3>
              <span className="row-end">
                {isTranscribing(m) && (
                  <span className="badge badge-info">
                    {m.transcription.status === 'queued' ? 'Queued for Whisper' : `Transcribing ${Math.round((m.transcription.progress || 0) * 100)}%`}
                  </span>
                )}
                {m.transcription?.status === 'failed' && <span className="badge badge-warn">Transcription failed</span>}
                {m.status === 'recording' && <span className="badge badge-warn">Interrupted</span>}
              </span>
            </div>
            <div className="meta">
              <span>{formatDate(m.startedAt || m.createdAt)}</span>
              <span>· {humanDuration(m.durationMs)}</span>
              <span>· {m.segmentCount} lines</span>
              {m.hasAudio && <span>· 🔊 audio</span>}
            </div>
            {m.preview && <p className="preview"><Highlight text={m.preview} query={debounced} /></p>}
            {m.tags?.length > 0 && (
              <div className="tags">{m.tags.map((t) => <span key={t} className="tag">#{t}</span>)}</div>
            )}
          </Link>
        ))}
      </div>

      {importing && <ImportDialog whisperAvailable={whisper.available} onClose={() => setImporting(false)} />}
      {loading && <div className="spinner" />}
      {!loading && data.page < data.pages && (
        <div className="center"><button className="btn" onClick={loadMore}>Load more</button></div>
      )}
    </>
  );
}
