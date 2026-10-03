const pad = (n, w = 2) => String(n).padStart(w, '0');

export function clock(ms) {
  const total = Math.floor(ms / 1000);
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

const cueTime = (ms, sep) => `${clock(ms)}${sep}${pad(Math.floor(ms % 1000), 3)}`;

const header = (m) =>
  [
    m.title,
    `Date: ${new Date(m.startedAt || m.createdAt).toLocaleString('en-US')}`,
    `Duration: ${clock(m.durationMs || 0)}`,
  ].join('\n');

const formats = {
  txt: {
    mime: 'text/plain',
    render: (m) =>
      `${header(m)}\n\n${m.segments.map((s) => `[${clock(s.startMs)}] ${s.speaker}: ${s.text}`).join('\n')}\n`,
  },
  md: {
    mime: 'text/markdown',
    render: (m) => {
      const lines = [
        `# ${m.title}`,
        '',
        `- **Date:** ${new Date(m.startedAt || m.createdAt).toLocaleString('en-US')}`,
        `- **Duration:** ${clock(m.durationMs || 0)}`,
      ];
      if (m.tags?.length) lines.push(`- **Tags:** ${m.tags.join(', ')}`);
      if (m.notes?.trim()) lines.push('', '## Notes', '', m.notes.trim());
      if (m.summary?.text) lines.push('', '## AI study notes', '', m.summary.text.replace(/^## /gm, '### '));
      const highlights = m.segments.filter((s) => s.highlighted);
      if (highlights.length) {
        lines.push('', '## Highlights', '');
        highlights.forEach((s) => lines.push(`- [${clock(s.startMs)}] **${s.speaker}:** ${s.text}`));
      }
      lines.push('', '## Transcript', '');
      m.segments.forEach((s) => lines.push(`**[${clock(s.startMs)}] ${s.speaker}:** ${s.text}`, ''));
      return lines.join('\n');
    },
  },
  srt: {
    mime: 'application/x-subrip',
    render: (m) =>
      m.segments
        .map((s, i) => `${i + 1}\n${cueTime(s.startMs, ',')} --> ${cueTime(s.endMs, ',')}\n${s.speaker}: ${s.text}\n`)
        .join('\n'),
  },
  vtt: {
    mime: 'text/vtt',
    render: (m) =>
      `WEBVTT\n\n${m.segments
        .map((s) => `${cueTime(s.startMs, '.')} --> ${cueTime(s.endMs, '.')}\n<v ${s.speaker}>${s.text}\n`)
        .join('\n')}`,
  },
  json: {
    mime: 'application/json',
    render: (m) => {
      const { user, audio, __v, ...rest } = m;
      return JSON.stringify(rest, null, 2);
    },
  },
};

export const exportFormats = Object.keys(formats);

export function renderExport(meeting, format) {
  const f = formats[format];
  const base = (meeting.title || 'meeting').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'meeting';
  return { body: f.render(meeting), mime: f.mime, filename: `${base}.${format}` };
}
