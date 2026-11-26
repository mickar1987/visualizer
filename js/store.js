// Autosave of the current work into the browser (IndexedDB), so a reload / closed tab doesn't lose it.
import { saveProject } from './project.js';

const DB = 'viz', ST = 'kv', KEY = 'autosave';
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function put(key, val) {
  const d = await db();
  return new Promise((res, rej) => { const tx = d.transaction(ST, 'readwrite'); tx.objectStore(ST).put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
async function get(key) {
  const d = await db();
  return new Promise((res, rej) => { const r = d.transaction(ST).objectStore(ST).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

let timer = null, busy = null;
export function scheduleAutosave(app) {
  clearTimeout(timer);
  timer = setTimeout(() => autosaveNow(app), 2500);
}
export async function autosaveNow(app) {
  clearTimeout(timer);
  if (!app.doc.bg) return;
  if (busy) await busy;
  busy = (async () => {
    try {
      const blob = await saveProject(app.doc, app.quote && app.quote.raw);
      await put(KEY, { blob, name: app.doc.projectName || '', time: Date.now(), saved: !app.dirty });
    } catch (e) { console.warn('autosave failed', e); }
  })();
  await busy;
  busy = null;
}
export async function loadAutosave() {
  const v = await get(KEY);
  return v && v.blob && !v.saved ? v : null;
}
export async function clearAutosave() { try { await put(KEY, null); } catch { /* ignore */ } }
export async function loadLast() { return get(KEY); }
