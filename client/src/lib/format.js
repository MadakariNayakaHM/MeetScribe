const pad = (n) => String(n).padStart(2, '0');

export function clock(ms = 0) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(t % 60)}` : `${pad(m)}:${pad(t % 60)}`;
}

export function humanDuration(ms = 0) {
  const mins = Math.round(ms / 60000);
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export const formatDate = (d) =>
  new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const defaultTitle = () =>
  `Meeting – ${new Date().toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;

export const LANGUAGES = [
  ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-IN', 'English (India)'], ['en-AU', 'English (Australia)'],
  ['hi-IN', 'Hindi'], ['kn-IN', 'Kannada'], ['ta-IN', 'Tamil'], ['te-IN', 'Telugu'], ['mr-IN', 'Marathi'],
  ['bn-IN', 'Bengali'], ['ml-IN', 'Malayalam'], ['gu-IN', 'Gujarati'],
  ['es-ES', 'Spanish'], ['fr-FR', 'French'], ['de-DE', 'German'], ['it-IT', 'Italian'], ['pt-BR', 'Portuguese (Brazil)'],
  ['nl-NL', 'Dutch'], ['ja-JP', 'Japanese'], ['ko-KR', 'Korean'], ['zh-CN', 'Chinese (Mandarin)'], ['ar-SA', 'Arabic'],
  ['ru-RU', 'Russian'],
];
