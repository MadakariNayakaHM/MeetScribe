// Minimal Markdown for AI answers: headings, lists, paragraphs, **bold**, *italic*, `code`,
// and [mm:ss] / [h:mm:ss] timestamps rendered as seek buttons. Builds React elements (no HTML injection).

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[\d{1,2}:\d{2}(?::\d{2})?\])/g;

export const parseClock = (s) => s.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0) * 1000;

function Inline({ text, onSeek }) {
  return text.split(INLINE).map((part, i) => {
    if (i % 2 === 0) return part;
    if (part.startsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('*')) return <em key={i}>{part.slice(1, -1)}</em>;
    const t = part.slice(1, -1);
    return onSeek ? (
      <button key={i} className="link ts" onClick={() => onSeek(parseClock(t))} title="Play from here">{t}</button>
    ) : (
      <span key={i} className="ts">{t}</span>
    );
  });
}

export default function Markdown({ text, onSeek }) {
  const blocks = [];
  let list = null;
  let para = [];

  const flushPara = () => {
    if (para.length) blocks.push(<p key={blocks.length}><Inline text={para.join(' ')} onSeek={onSeek} /></p>);
    para = [];
  };
  const flushList = () => {
    if (list) {
      const Tag = list.ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag key={blocks.length}>
          {list.items.map((it, i) => (
            <li key={i} className={it.nested ? 'nested' : undefined}><Inline text={it.text} onSeek={onSeek} /></li>
          ))}
        </Tag>,
      );
    }
    list = null;
  };

  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      const Tag = heading[1].length <= 2 ? 'h4' : 'h5';
      blocks.push(<Tag key={blocks.length}><Inline text={heading[2].replace(/\*\*/g, '')} onSeek={onSeek} /></Tag>);
    } else if (item) {
      flushPara();
      const ordered = /\d/.test(item[2]);
      if (!list || (list.ordered !== ordered && !item[1])) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push({ text: item[3], nested: item[1].length >= 2 });
    } else if (list && /^\s+\S/.test(raw)) {
      list.items[list.items.length - 1].text += ` ${line.trim()}`;
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return <div className="md">{blocks}</div>;
}
