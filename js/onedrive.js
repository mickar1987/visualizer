// OneDrive (Microsoft Graph) access from the browser: OAuth 2.0 authorization code + PKCE, no server needed.
import { CONFIG } from '../config.js';
import { t } from './i18n.js';

const TOKENS = 'viz.od.tokens', PENDING = 'viz.od.pending', REDIRECT_RESULT = 'viz.od.redirect';
const SCOPES = 'Files.ReadWrite User.Read offline_access openid profile';
const GRAPH = 'https://graph.microsoft.com/v1.0';

// needs https (or localhost): not available when the app is opened as a local file
export const configured = () => location.protocol !== 'file:' && !!(CONFIG.onedriveClientId && CONFIG.onedriveClientId.trim());
const authority = () => (CONFIG.authority || 'https://login.microsoftonline.com/common').replace(/\/$/, '');
export const redirectUri = () => new URL('auth.html', location.href.split('#')[0].split('?')[0]).href;

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

function load(key, store = localStorage) { try { return JSON.parse(store.getItem(key) || 'null'); } catch { return null; } }
function save(key, v, store = localStorage) { try { v == null ? store.removeItem(key) : store.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }

export const isSignedIn = () => !!load(TOKENS);
export const account = () => (load(TOKENS) || {}).account || null;

async function authUrl() {
  const verifier = rand(48);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = rand(16);
  save(PENDING, { verifier, state }, sessionStorage);
  const q = new URLSearchParams({
    client_id: CONFIG.onedriveClientId, response_type: 'code', redirect_uri: redirectUri(), response_mode: 'query',
    scope: SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
  });
  return `${authority()}/oauth2/v2.0/authorize?${q}`;
}

async function tokenRequest(params) {
  const r = await fetch(`${authority()}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CONFIG.onedriveClientId, scope: SCOPES, ...params }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
  return j;
}

async function finish(params) {
  const pending = load(PENDING, sessionStorage);
  save(PENDING, null, sessionStorage);
  if (params.get('error')) throw new Error(params.get('error_description') || params.get('error'));
  if (!pending || params.get('state') !== pending.state) throw new Error(t('ההתחברות ל-OneDrive נכשלה (state)'));
  const j = await tokenRequest({ grant_type: 'authorization_code', code: params.get('code'), redirect_uri: redirectUri(), code_verifier: pending.verifier });
  const tok = { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in - 120) * 1000, account: null };
  save(TOKENS, tok);
  try {
    const me = await api('/me?$select=displayName,mail,userPrincipalName');
    tok.account = me.displayName || me.mail || me.userPrincipalName;
    save(TOKENS, tok);
  } catch { /* not essential */ }
  return tok.account;
}

/** Sign in with a popup; falls back to a full-page redirect when popups are blocked. */
export async function signIn() {
  if (!configured()) throw new Error(t('OneDrive לא הוגדר (חסר Client ID בקובץ config.js)'));
  const url = await authUrl();
  const w = 520, hgt = 680;
  const popup = window.open(url, 'od_login', `width=${w},height=${hgt},left=${(screen.width - w) / 2},top=${(screen.height - hgt) / 2}`);
  if (!popup) { location.assign(url); return new Promise(() => {}); }
  const params = await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (popup.closed) { clearInterval(timer); reject(new Error(t('חלון ההתחברות נסגר'))); return; }
      let href = '';
      try { href = popup.location.href; } catch { return; } // still on login.microsoftonline.com
      if (href.startsWith(redirectUri())) {
        clearInterval(timer);
        const p = new URL(href).searchParams;
        popup.close();
        resolve(p);
      }
    }, 150);
  });
  return finish(params);
}

/** Called at startup: completes a redirect sign-in (auth.html stored the result). */
export async function completeRedirect() {
  const r = sessionStorage.getItem(REDIRECT_RESULT);
  if (!r) return null;
  sessionStorage.removeItem(REDIRECT_RESULT);
  return finish(new URLSearchParams(r));
}

export function signOut() { save(TOKENS, null); }

async function token() {
  const tok = load(TOKENS);
  if (!tok) throw new Error(t('לא מחובר ל-OneDrive'));
  if (Date.now() < tok.exp) return tok.access;
  try {
    const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh });
    Object.assign(tok, { access: j.access_token, refresh: j.refresh_token || tok.refresh, exp: Date.now() + (j.expires_in - 120) * 1000 });
    save(TOKENS, tok);
    return tok.access;
  } catch (e) {
    save(TOKENS, null);
    throw new Error(t('החיבור ל-OneDrive פג. יש להתחבר מחדש.'));
  }
}

export async function api(path, opts = {}) {
  const r = await fetch(path.startsWith('http') ? path : GRAPH + path, {
    ...opts, headers: { Authorization: `Bearer ${await token()}`, ...(opts.json ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
    body: opts.json ? JSON.stringify(opts.json) : opts.body,
  });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `OneDrive: HTTP ${r.status}`);
  return j;
}

const itemPath = (id) => (id && id !== 'root' ? `/me/drive/items/${id}` : '/me/drive/root');

export async function children(id) {
  let url = `${itemPath(id)}/children?$select=id,name,folder,file,size,lastModifiedDateTime&$top=200`;
  const out = [];
  while (url) { const j = await api(url); out.push(...j.value); url = j['@odata.nextLink']; }
  return out.sort((a, b) => (!!b.folder - !!a.folder) || a.name.localeCompare(b.name));
}

export const createFolder = (parentId, name) => api(`${itemPath(parentId)}/children`, {
  method: 'POST', json: { name, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' },
});

export async function upload(parentId, name, blob, onProgress) {
  const p = `${itemPath(parentId)}:/${encodeURIComponent(name)}:`;
  if (blob.size < 4 * 1024 * 1024) {
    const r = await api(`${p}/content?@microsoft.graph.conflictBehavior=replace`, { method: 'PUT', body: blob, headers: { 'Content-Type': blob.type || 'application/octet-stream' } });
    onProgress && onProgress(1);
    return r;
  }
  const s = await api(`${p}/createUploadSession`, { method: 'POST', json: { item: { '@microsoft.graph.conflictBehavior': 'replace' } } });
  const CH = 320 * 1024 * 16; // multiple of 320 KiB
  let res = null;
  for (let pos = 0; pos < blob.size; pos += CH) {
    const end = Math.min(blob.size, pos + CH);
    const r = await fetch(s.uploadUrl, { method: 'PUT', body: blob.slice(pos, end), headers: { 'Content-Range': `bytes ${pos}-${end - 1}/${blob.size}` } });
    if (!r.ok && r.status !== 202) throw new Error(`OneDrive upload: HTTP ${r.status}`);
    if (r.status === 200 || r.status === 201) res = await r.json();
    onProgress && onProgress(end / blob.size);
  }
  return res;
}

export async function download(id) {
  const j = await api(`/me/drive/items/${id}?$select=id,name,file,@microsoft.graph.downloadUrl`);
  const r = await fetch(j['@microsoft.graph.downloadUrl']);
  if (!r.ok) throw new Error(`OneDrive download: HTTP ${r.status}`);
  const b = await r.blob();
  return new File([b], j.name, { type: (j.file && j.file.mimeType) || b.type });
}

export async function pathOf(id) {
  if (!id || id === 'root') return [{ id: 'root', name: 'OneDrive' }];
  const j = await api(`/me/drive/items/${id}?$select=id,name,parentReference`);
  const parts = [{ id: j.id, name: j.name }];
  let parent = j.parentReference;
  while (parent && parent.id && parent.path && parent.path !== '/drive/root:') {
    const pj = await api(`/me/drive/items/${parent.id}?$select=id,name,parentReference`);
    parts.unshift({ id: pj.id, name: pj.name });
    parent = pj.parentReference;
  }
  parts.unshift({ id: 'root', name: 'OneDrive' });
  return parts;
}
