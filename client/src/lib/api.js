const TOKEN_KEY = 'meetscribe.token';

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY)),
};

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

async function request(method, url, body) {
  const headers = {};
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(`/api${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error('Cannot reach the server. Check your connection.');
  }
  if (res.status === 401 && token) onUnauthorized();
  if (res.status === 204) return null;
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.blob();
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body ?? {}),
  patch: (url, body) => request('PATCH', url, body),
  put: (url, body) => request('PUT', url, body),
  del: (url) => request('DELETE', url),
};

/** files: { audio: Blob|File, tracks?: Blob } */
export function uploadAudio(meetingId, files, onProgress, { transcribe = true } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/meetings/${meetingId}/audio${transcribe ? '' : '?transcribe=false'}`);
    xhr.setRequestHeader('Authorization', `Bearer ${tokenStore.get()}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed: network error'));
    const form = new FormData();
    for (const [field, blob] of Object.entries(files)) {
      if (blob) form.append(field, blob, blob.name || `${field}.${extensionOf(blob.type)}`);
    }
    xhr.send(form);
  });
}

const extensionOf = (mime = '') =>
  mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'audio';

export async function downloadExport(meetingId, format) {
  const res = await fetch(`/api/meetings/${meetingId}/export?format=${format}`, {
    headers: { Authorization: `Bearer ${tokenStore.get()}` },
  });
  if (!res.ok) throw new Error('Export failed');
  const name = /filename="?([^"]+)"?/.exec(res.headers.get('content-disposition') || '')?.[1] || `meeting.${format}`;
  saveBlob(await res.blob(), name);
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
