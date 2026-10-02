import { useEffect, useState } from 'react';
import { api } from './api.js';

let cached = null;
const fallback = { whisper: { available: false } };

export function useServerConfig() {
  const [config, setConfig] = useState(cached || fallback);
  useEffect(() => {
    if (cached) return;
    api.get('/config').then((c) => { cached = c; setConfig(c); }).catch(() => {});
  }, []);
  return config;
}
