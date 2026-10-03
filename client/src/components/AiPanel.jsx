import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, saveBlob } from '../lib/api.js';
import { formatDate } from '../lib/format.js';
import Markdown from './Markdown.jsx';

const SUGGESTIONS = [
  'What were the main topics, in order?',
  'Explain the hardest concept from this session simply.',
  'Were any assignments, exams or deadlines mentioned?',
  'Give me 5 quiz questions with answers.',
];

let aiStatusCache = null;

/** Whether the user has an AI key saved (cached value shown first, refreshed on mount). */
function useAiReady() {
  const [ready, setReady] = useState(aiStatusCache);
  useEffect(() => {
    api.get('/settings/ai')
      .then((s) => { aiStatusCache = s.hasKey; setReady(s.hasKey); })
      .catch(() => setReady(false));
  }, []);
  return ready;
}

function SetupHint() {
  return (
    <div className="hint ai-empty">
      Add your <b>OpenAI</b> API key in <Link to="/settings">Settings</Link> to generate study
      notes and ask questions about this meeting.
    </div>
  );
}

export function SummaryTab({ meeting, onChange, onSeek, setToast }) {
  const ready = useAiReady();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const summary = meeting.summary?.text ? meeting.summary : null;
  const hasTranscript = meeting.segments.length > 0;

  async function generate() {
    if (summary && !window.confirm('Replace the current study notes with new ones?')) return;
    setBusy(true);
    setError('');
    try {
      const { summary: s } = await api.post(`/meetings/${meeting._id}/summary`);
      onChange({ summary: s });
      setToast('Study notes ready');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (ready === false && !summary) return <SetupHint />;
  if (!hasTranscript && !summary) return <p className="muted center">There is no transcript to summarize yet.</p>;

  return (
    <div className="ai-pane">
      <div className="row-between ai-head">
        <span className="muted small">
          {summary
            ? `Generated ${formatDate(summary.generatedAt)} · ${summary.model}`
            : 'Summary, key concepts, formulas, deadlines and review questions — with timestamps you can click.'}
        </span>
        <div className="row-end">
          {summary && (
            <>
              <button className="btn btn-sm btn-ghost" onClick={() => navigator.clipboard.writeText(summary.text).then(() => setToast('Notes copied'))}>Copy</button>
              <button className="btn btn-sm btn-ghost" onClick={() => saveBlob(new Blob([`# ${meeting.title}\n\n${summary.text}\n`], { type: 'text/markdown' }), `${meeting.title.replace(/[^\w\- ]+/g, '').trim() || 'meeting'} - notes.md`)}>⤓ .md</button>
            </>
          )}
          <button className={`btn btn-sm ${summary ? '' : 'btn-primary'}`} onClick={generate} disabled={busy || !ready || !hasTranscript}>
            {busy ? 'Writing notes…' : summary ? '↻ Regenerate' : '✨ Generate study notes'}
          </button>
        </div>
      </div>
      {busy && <p className="muted small">This usually takes 10–60 seconds for a 1-hour class.</p>}
      {error && <div className="alert alert-error">{error}{/settings/i.test(error) && <> — <Link to="/settings">open Settings</Link></>}</div>}
      {summary && <Markdown text={summary.text} onSeek={onSeek} />}
    </div>
  );
}

export function AskTab({ meeting, onChange, onSeek, setToast }) {
  const ready = useAiReady();
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const endRef = useRef(null);
  const chat = meeting.chat ?? [];

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [chat.length, pending]);

  async function ask(q = question) {
    q = q.trim();
    if (!q || pending) return;
    setPending(q);
    setQuestion('');
    setError('');
    try {
      const { messages } = await api.post(`/meetings/${meeting._id}/chat`, { question: q });
      onChange({ chat: [...chat, ...messages] });
    } catch (e) {
      setError(e.message);
      setQuestion(q);
    } finally {
      setPending('');
    }
  }

  async function clear() {
    if (!window.confirm('Clear this conversation?')) return;
    try {
      await api.del(`/meetings/${meeting._id}/chat`);
      onChange({ chat: [] });
    } catch (e) {
      setToast(`⚠ ${e.message}`);
    }
  }

  if (ready === false && !chat.length) return <SetupHint />;
  if (!meeting.segments.length) return <p className="muted center">There is no transcript to ask about yet.</p>;

  return (
    <div className="ai-pane">
      {chat.length === 0 && !pending && (
        <div className="suggestions">
          <p className="muted small">Ask anything about this session. Answers cite timestamps you can click to replay.</p>
          {SUGGESTIONS.map((s) => (
            <button key={s} className="btn btn-sm" onClick={() => ask(s)} disabled={!ready}>{s}</button>
          ))}
        </div>
      )}

      <div className="chat">
        {chat.map((m) => (
          <div key={m._id} className={`msg msg-${m.role}`}>
            {m.role === 'assistant' ? <Markdown text={m.content} onSeek={onSeek} /> : <p>{m.content}</p>}
          </div>
        ))}
        {pending && (
          <>
            <div className="msg msg-user"><p>{pending}</p></div>
            <div className="msg msg-assistant"><p className="muted">Thinking…</p></div>
          </>
        )}
        <div ref={endRef} />
      </div>

      {error && <div className="alert alert-error">{error}{/settings/i.test(error) && <> — <Link to="/settings">open Settings</Link></>}</div>}

      <form className="ask-form" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <textarea
          rows={2}
          value={question}
          placeholder="e.g. What did the teacher say about overfitting?"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }}
          maxLength={4000}
          disabled={!ready}
        />
        <div className="row-between">
          {chat.length > 0 ? <button type="button" className="btn btn-sm btn-ghost" onClick={clear}>Clear chat</button> : <span />}
          <button className="btn btn-primary btn-sm" disabled={!ready || !question.trim() || Boolean(pending)}>Ask</button>
        </div>
      </form>
    </div>
  );
}
