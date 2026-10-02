import { memo, useEffect, useRef, useState } from 'react';
import { clock } from '../lib/format.js';
import Highlight from './Highlight.jsx';

function Segment({ seg, active, follow, query, canSeek, locked, onSeek, onSave, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(seg.text);
  const [speaker, setSpeaker] = useState(seg.speaker);
  const ref = useRef(null);

  useEffect(() => {
    if (active && follow && !editing) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [active, follow, editing]);

  const beginEdit = () => {
    setText(seg.text);
    setSpeaker(seg.speaker);
    setEditing(true);
  };

  async function save() {
    const body = {};
    if (text.trim() !== seg.text) body.text = text;
    if (speaker.trim() !== seg.speaker) body.speaker = speaker;
    if (!text.trim()) return;
    if (Object.keys(body).length === 0 || (await onSave(body))) setEditing(false);
  }

  return (
    <div ref={ref} className={`seg ${active ? 'seg-active' : ''} ${seg.highlighted ? 'seg-hl' : ''}`}>
      <button className="seg-time link" onClick={onSeek} disabled={!canSeek} title={canSeek ? 'Play from here' : undefined}>
        {clock(seg.startMs)}
      </button>
      <div className="seg-body">
        {editing ? (
          <div className="seg-edit">
            <input value={speaker} onChange={(e) => setSpeaker(e.target.value)} maxLength={60} aria-label="Speaker" />
            <textarea
              autoFocus
              value={text}
              rows={Math.min(8, Math.max(2, Math.ceil(text.length / 80)))}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
                if (e.key === 'Escape') setEditing(false);
              }}
            />
            <div className="row-end">
              <button className="btn btn-sm" onClick={() => setEditing(false)}>Cancel</button>
              <button className="btn btn-sm btn-primary" onClick={save} disabled={!text.trim()}>Save</button>
            </div>
          </div>
        ) : (
          <>
            <span className="seg-speaker">{seg.speaker}</span>
            <p onDoubleClick={locked ? undefined : beginEdit}><Highlight text={seg.text} query={query} /></p>
          </>
        )}
      </div>
      {!editing && !locked && (
        <div className="seg-actions">
          <button className={`icon ${seg.highlighted ? 'on' : ''}`} title="Highlight" onClick={() => onSave({ highlighted: !seg.highlighted })}>★</button>
          <button className="icon" title="Edit (or double-click the text)" onClick={beginEdit}>✎</button>
          <button className="icon" title="Delete line" onClick={() => window.confirm('Delete this line?') && onDelete()}>🗑</button>
        </div>
      )}
    </div>
  );
}

export default memo(Segment);
