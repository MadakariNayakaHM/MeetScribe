import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, downloadExport } from '../lib/api.js';
import { clock, formatDate, humanDuration } from '../lib/format.js';
import Highlight from '../components/Highlight.jsx';
import Segment from '../components/Segment.jsx';
import { useServerConfig } from '../lib/useServerConfig.js';

const EXPORTS = [
  ['md', 'Markdown (.md)'],
  ['txt', 'Plain text (.txt)'],
  ['srt', 'Subtitles (.srt)'],
  ['vtt', 'WebVTT (.vtt)'],
  ['json', 'JSON (.json)'],
];

export default function MeetingPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [meeting, setMeeting] = useState(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [currentMs, setCurrentMs] = useState(0);
  const [filter, setFilter] = useState('');
  const [onlyHighlights, setOnlyHighlights] = useState(false);
  const [follow, setFollow] = useState(true);
  const audioRef = useRef(null);
  const { whisper } = useServerConfig();

  useEffect(() => {
    let cancelled = false;
    api.get(`/meetings/${id}`)
      .then(async ({ meeting }) => {
        if (cancelled) return;
        setMeeting(meeting);
        if (meeting.hasAudio) {
          const { url } = await api.get(`/meetings/${id}/audio-url`);
          if (!cancelled) setAudioUrl(url);
        }
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [id]);

  const tStatus = meeting?.transcription?.status;
  const transcribing = tStatus === 'queued' || tStatus === 'processing';

  // Poll while Whisper is working; pick up the new transcript when it lands.
  useEffect(() => {
    if (!transcribing) return;
    const t = setInterval(async () => {
      try {
        const { meeting: m } = await api.get(`/meetings/${id}`);
        setMeeting(m);
        if (m.transcription?.status === 'done') setToast('Whisper transcript ready');
        if (m.transcription?.status === 'failed') setToast('⚠ Whisper transcription failed');
      } catch { /* keep polling */ }
    }, 3000);
    return () => clearInterval(t);
  }, [id, transcribing]);

  async function transcribe() {
    if (segments.length && !window.confirm('Replace the current transcript with a new Whisper transcript? Edits to lines will be lost (highlights are kept).')) return;
    try {
      const { meeting: m } = await api.post(`/meetings/${id}/transcribe`);
      setMeeting(m);
    } catch (e) {
      setToast(`⚠ ${e.message}`);
    }
  }

  async function cancelTranscription() {
    try {
      const { meeting: m } = await api.del(`/meetings/${id}/transcribe`);
      setMeeting(m);
    } catch (e) {
      setToast(`⚠ ${e.message}`);
    }
  }

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const segments = meeting?.segments ?? [];

  const activeId = useMemo(() => {
    let active = null;
    for (const seg of segments) {
      if (seg.startMs <= currentMs + 250) active = seg._id;
      else break;
    }
    return active;
  }, [segments, currentMs]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return segments.filter(
      (seg) => (!onlyHighlights || seg.highlighted) && (!q || seg.text.toLowerCase().includes(q) || seg.speaker.toLowerCase().includes(q)),
    );
  }, [segments, filter, onlyHighlights]);

  const stats = useMemo(() => {
    const bySpeaker = {};
    let words = 0;
    for (const seg of segments) {
      const w = seg.text.split(/\s+/).filter(Boolean).length;
      words += w;
      const sp = (bySpeaker[seg.speaker] ??= { ms: 0, words: 0, lines: 0 });
      sp.ms += Math.max(0, seg.endMs - seg.startMs);
      sp.words += w;
      sp.lines += 1;
    }
    const totalWords = words || 1;
    return {
      words,
      speakers: Object.entries(bySpeaker)
        .map(([name, v]) => ({ name, ...v, share: v.words / totalWords }))
        .sort((a, b) => b.words - a.words),
    };
  }, [segments]);

  const update = async (body, okMsg) => {
    try {
      const { meeting: m } = await api.patch(`/meetings/${id}`, body);
      setMeeting(m);
      if (okMsg) setToast(okMsg);
    } catch (e) {
      setToast(`⚠ ${e.message}`);
    }
  };

  const replaceSegment = (seg) =>
    setMeeting((m) => ({ ...m, segments: m.segments.map((x) => (x._id === seg._id ? seg : x)) }));

  async function saveSegment(segId, body) {
    try {
      const { segment } = await api.patch(`/meetings/${id}/segments/${segId}`, body);
      replaceSegment(segment);
      return true;
    } catch (e) {
      setToast(`⚠ ${e.message}`);
      return false;
    }
  }

  async function deleteSegment(segId) {
    try {
      await api.del(`/meetings/${id}/segments/${segId}`);
      setMeeting((m) => ({ ...m, segments: m.segments.filter((x) => x._id !== segId) }));
    } catch (e) {
      setToast(`⚠ ${e.message}`);
    }
  }

  async function renameSpeaker(from, to) {
    to = to.trim();
    if (!to || to === from) return;
    try {
      const { meeting: m } = await api.patch(`/meetings/${id}/speakers`, { from, to });
      setMeeting(m);
      setToast(`Renamed “${from}” to “${to}”`);
    } catch (e) {
      setToast(`⚠ ${e.message}`);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete “${meeting.title}” and its recording? This cannot be undone.`)) return;
    try {
      await api.del(`/meetings/${id}`);
      navigate('/', { replace: true });
    } catch (e) {
      setToast(`⚠ ${e.message}`);
    }
  }

  function seek(ms) {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = ms / 1000;
    a.play().catch(() => {});
  }

  if (error) return <div className="alert alert-error">{error}</div>;
  if (!meeting) return <div className="spinner" />;

  return (
    <div className="meeting">
      <div className="page-head">
        <div className="grow">
          <input
            className="title-input"
            defaultValue={meeting.title}
            key={meeting.title}
            maxLength={200}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (!v) e.target.value = meeting.title;
              else if (v !== meeting.title) update({ title: v }, 'Title saved');
            }}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          <div className="meta">
            <span>{formatDate(meeting.startedAt || meeting.createdAt)}</span>
            <span>· {humanDuration(meeting.durationMs)}</span>
            <span>· {stats.words.toLocaleString()} words</span>
            <span>· {meeting.language}</span>
          </div>
        </div>
        <div className="row-end">
          <select
            className="btn"
            value=""
            onChange={(e) => {
              const fmt = e.target.value;
              if (fmt) downloadExport(id, fmt).catch((err) => setToast(`⚠ ${err.message}`));
            }}
          >
            <option value="">⤓ Export…</option>
            {EXPORTS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          {audioUrl && <a className="btn" href={`${audioUrl}&download=1`}>⤓ Audio</a>}
          <button className="btn" onClick={() => navigator.clipboard.writeText(segments.map((s) => `[${clock(s.startMs)}] ${s.speaker}: ${s.text}`).join('\n')).then(() => setToast('Transcript copied'))}>
            Copy
          </button>
          <button className="btn btn-danger" onClick={remove}>Delete</button>
        </div>
      </div>

      {meeting.status === 'recording' && (
        <div className="alert alert-warn row-between">
          <span>This recording was interrupted before it finished. The transcript up to that point was saved{meeting.hasAudio ? '' : ', but no audio was uploaded'}.</span>
          <button className="btn btn-sm" onClick={() => update({ status: 'completed', durationMs: meeting.durationMs || segments.at(-1)?.endMs || 0 }, 'Marked as completed')}>
            Mark as completed
          </button>
        </div>
      )}

      <TranscriptionBar
        meeting={meeting}
        whisper={whisper}
        onTranscribe={transcribe}
        onCancel={cancelTranscription}
      />

      {audioUrl && (
        <div className="card player">
          <audio
            ref={audioRef}
            src={audioUrl}
            controls
            preload="metadata"
            onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
            onSeeked={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
          />
          <label className="check"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow along</label>
        </div>
      )}

      <div className="meeting-grid">
        <section className="card transcript">
          <div className="transcript-tools">
            <input type="search" placeholder="Find in transcript…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <label className="check">
              <input type="checkbox" checked={onlyHighlights} onChange={(e) => setOnlyHighlights(e.target.checked)} /> ★ Highlights only
            </label>
          </div>
          {segments.length === 0 && <p className="muted center">No transcript was captured for this meeting.</p>}
          {segments.length > 0 && visible.length === 0 && <p className="muted center">Nothing matches.</p>}
          {visible.map((seg) => (
            <Segment
              key={seg._id}
              seg={seg}
              active={Boolean(audioUrl) && seg._id === activeId}
              follow={follow && !filter}
              query={filter.trim()}
              canSeek={Boolean(audioUrl)}
              locked={transcribing}
              onSeek={() => seek(seg.startMs)}
              onSave={(body) => saveSegment(seg._id, body)}
              onDelete={() => deleteSegment(seg._id)}
            />
          ))}
        </section>

        <aside className="side">
          <div className="card">
            <h3>Notes</h3>
            <textarea
              rows={6}
              placeholder="Agenda, decisions, follow-ups…"
              defaultValue={meeting.notes}
              onBlur={(e) => e.target.value !== meeting.notes && update({ notes: e.target.value }, 'Notes saved')}
            />
          </div>

          <div className="card">
            <h3>Tags</h3>
            <TagEditor tags={meeting.tags} onChange={(tags) => update({ tags })} />
          </div>

          {stats.speakers.length > 0 && (
            <div className="card">
              <h3>Speakers</h3>
              <p className="muted small">Rename a speaker to update every line they said.</p>
              {stats.speakers.map((sp) => (
                <div key={sp.name} className="speaker-row">
                  <input
                    defaultValue={sp.name}
                    key={sp.name}
                    disabled={transcribing}
                    maxLength={60}
                    onBlur={(e) => renameSpeaker(sp.name, e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  />
                  <div className="bar"><div style={{ width: `${Math.round(sp.share * 100)}%` }} /></div>
                  <span className="small muted">{Math.round(sp.share * 100)}% · {sp.lines} lines</span>
                </div>
              ))}
            </div>
          )}

          {segments.some((s) => s.highlighted) && (
            <div className="card">
              <h3>★ Highlights</h3>
              <ul className="hl-list">
                {segments.filter((s) => s.highlighted).map((s) => (
                  <li key={s._id}>
                    <button className="link" onClick={() => seek(s.startMs)} disabled={!audioUrl}>{clock(s.startMs)}</button>{' '}
                    <Highlight text={s.text} query="" />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function TranscriptionBar({ meeting, whisper, onTranscribe, onCancel }) {
  const t = meeting.transcription || {};
  if (t.status === 'queued' || t.status === 'processing') {
    const pct = Math.round((t.progress || 0) * 100);
    return (
      <div className="card tx-bar">
        <div className="grow">
          <b>{t.status === 'queued' ? 'Waiting for Whisper…' : `Transcribing with Whisper… ${pct}%`}</b>
          <p className="muted small">
            {meeting.hasTracks ? 'Transcribing your mic and the other participants separately. ' : ''}
            Runs locally on the server. Editing is paused until it finishes.
          </p>
          <div className="bar"><div style={{ width: `${t.status === 'queued' ? 0 : Math.max(3, pct)}%` }} /></div>
        </div>
        <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    );
  }
  if (t.status === 'failed') {
    return (
      <div className="alert alert-error row-between">
        <span>Whisper transcription failed: {t.error || 'unknown error'}</span>
        {whisper.available && <button className="btn btn-sm" onClick={onTranscribe}>Retry</button>}
      </div>
    );
  }
  if (!meeting.hasAudio) return null;
  return (
    <div className="tx-source row-between">
      <span className="muted small">
        {t.source === 'whisper'
          ? `Transcript by local Whisper (${t.model || 'model'})${meeting.hasTracks ? ' · separate tracks for you and others' : ''}`
          : 'Live browser transcript'}
      </span>
      {whisper.available && (
        <button className="btn btn-sm btn-ghost" onClick={onTranscribe}>
          {t.source === 'whisper' ? '↻ Re-transcribe' : '✨ Improve with Whisper'}
        </button>
      )}
    </div>
  );
}

function TagEditor({ tags, onChange }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim().toLowerCase().replace(/^#/, '');
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setDraft('');
  };
  return (
    <div>
      <div className="tags">
        {tags.map((t) => (
          <span key={t} className="tag">
            #{t} <button className="tag-x" onClick={() => onChange(tags.filter((x) => x !== t))} aria-label={`Remove ${t}`}>×</button>
          </span>
        ))}
      </div>
      <input
        placeholder="Add tag and press Enter"
        value={draft}
        maxLength={40}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }}
        onBlur={add}
      />
    </div>
  );
}
