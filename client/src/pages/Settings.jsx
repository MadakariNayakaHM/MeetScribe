import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

export default function Settings() {
  const [ai, setAi] = useState(null);
  const [form, setForm] = useState({ model: '', apiKey: '' });
  const [models, setModels] = useState([]);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null); // { ok, text }
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/settings/ai')
      .then((s) => {
        setAi(s);
        setForm({ model: s.model, apiKey: '' });
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!ai?.hasKey) {
      setModels([]);
      return;
    }
    let cancelled = false;
    api.get('/settings/ai/models')
      .then(({ models }) => !cancelled && setModels(models))
      .catch(() => {});
    return () => { cancelled = true; };
  }, [ai?.hasKey]);

  if (error) return <div className="alert alert-error">{error}</div>;
  if (!ai) return <div className="spinner" />;

  const set = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setResult(null);
  };

  async function run(kind, fn) {
    setBusy(kind);
    setResult(null);
    try {
      await fn();
    } catch (e) {
      setResult({ ok: false, text: e.message });
    } finally {
      setBusy('');
    }
  }

  const save = () =>
    run('save', async () => {
      if (!ai.hasKey && !form.apiKey) throw new Error('Paste your API key first.');
      const s = await api.put('/settings/ai', form);
      setAi(s);
      setForm((f) => ({ ...f, apiKey: '' }));
      setResult({ ok: true, text: 'Saved. Summaries and Q&A are ready to use on any meeting.' });
    });

  const test = () =>
    run('test', async () => {
      const r = await api.post('/settings/ai/test', form);
      setResult({ ok: true, text: `Connected — ${r.model} replied “${r.reply}” in ${(r.ms / 1000).toFixed(1)}s.` });
    });

  const removeKey = () =>
    run('remove', async () => {
      if (!window.confirm('Remove the saved API key?')) return;
      const s = await api.del('/settings/ai/key');
      setAi(s);
      setResult({ ok: true, text: 'API key removed.' });
    });

  return (
    <div className="setup card settings">
      <div>
        <h1>AI settings</h1>
        <p className="muted">
          Uses OpenAI for <b>study notes</b> and <b>Ask</b> on your meetings. Recording and Whisper transcription stay on
          your computer; only the transcript text of the meeting you ask about is sent to OpenAI.
        </p>
      </div>

      <label>
        OpenAI API key
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={form.apiKey}
          onChange={(e) => set({ apiKey: e.target.value.trim() })}
          placeholder={ai.hasKey ? `Saved (…${ai.keyHint}) — leave empty to keep it` : 'sk-…'}
        />
        <span className="small muted">
          Get one at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">platform.openai.com/api-keys</a>.
          Stored encrypted on your MeetScribe server and never shown again.
        </span>
      </label>

      <label>
        Model
        <input
          list="model-options"
          value={form.model}
          onChange={(e) => set({ model: e.target.value.trim() })}
          placeholder={`Default: ${ai.defaultModel}`}
          spellCheck={false}
        />
        <datalist id="model-options">
          {models.map((m) => <option key={m} value={m} />)}
        </datalist>
        <span className="small muted">
          {models.length ? `${models.length} models available — start typing to search.` : 'Save your key to list available models.'}
        </span>
      </label>

      {result && <div className={`alert ${result.ok ? 'alert-ok' : 'alert-error'}`}>{result.text}</div>}

      <div className="row-end" style={{ justifyContent: 'flex-start' }}>
        <button className="btn btn-primary" onClick={save} disabled={Boolean(busy)}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        <button className="btn" onClick={test} disabled={Boolean(busy) || (!form.apiKey && !ai.hasKey)}>
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        {ai.hasKey && (
          <button className="btn btn-ghost btn-danger" onClick={removeKey} disabled={Boolean(busy)}>Remove key</button>
        )}
      </div>
    </div>
  );
}
