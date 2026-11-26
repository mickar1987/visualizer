// Hebrew is the source language; English texts come from en.js (Hebrew -> English).
import { EN } from './en.js';

const KEY = 'viz.lang';
function readLang() {
  try { return localStorage.getItem(KEY) || 'he'; } catch { return 'he'; }
}
export const LANG = readLang();
export const isRTL = () => LANG === 'he';

export function setLanguage(code) {
  try { localStorage.setItem(KEY, code); } catch { /* private mode */ }
}

const missing = new Set();
/** t('גודל: {0} ס״מ', dims) */
export function t(s, ...args) {
  let out = s;
  if (LANG === 'en') {
    if (s in EN) out = EN[s];
    else if (!missing.has(s)) { missing.add(s); console.warn('[i18n] missing:', JSON.stringify(s)); }
  }
  return args.length ? out.replace(/\{(\d+)\}/g, (m, i) => (args[i] !== undefined ? args[i] : m)) : out;
}

/** Translate every element marked with data-t (text) / data-t-title / data-t-ph in the page. */
export function translateDom(root = document) {
  root.querySelectorAll('[data-t]').forEach((el) => {
    if (!el.dataset.t) el.dataset.t = el.textContent.trim();
    el.textContent = t(el.dataset.t);
  });
  root.querySelectorAll('[data-t-title]').forEach((el) => { el.title = t(el.dataset.tTitle); });
  root.querySelectorAll('[data-t-ph]').forEach((el) => { el.placeholder = t(el.dataset.tPh); });
}
