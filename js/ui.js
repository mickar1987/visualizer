// Small UI toolkit: modal dialogs, prompts, progress, toasts.
import { t } from './i18n.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

/**
 * dialog({title, body, buttons:[{label, value, primary, danger}], dismiss}) -> Promise(value)
 * A button may have validate(): returning false keeps the dialog open.
 */
export function dialog({ title, body, buttons = [{ label: t('אישור'), value: true, primary: true }], dismiss = null, cls = '' }) {
  return new Promise((resolve) => {
    const back = h('div', { class: 'modal-back' });
    const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const footer = h('footer');
    for (const b of buttons) {
      footer.append(h('button', {
        class: b.primary ? 'primary' : b.danger ? 'danger' : '',
        onclick: async () => { if (b.validate && !(await b.validate())) return; close(b.value); },
      }, b.label));
    }
    const m = h('div', { class: 'modal ' + cls }, h('header', {}, title || ''), h('div', { class: 'body' }, body || ''), buttons.length ? footer : null);
    back.append(m);
    back.addEventListener('pointerdown', (e) => { if (e.target === back && dismiss !== undefined) close(dismiss); });
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(dismiss); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
        const p = buttons.find((b) => b.primary);
        if (p) { e.preventDefault(); e.stopPropagation(); footer.children[buttons.indexOf(p)].click(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.getElementById('modalRoot').append(back);
    const f = m.querySelector('input, select');
    if (f) setTimeout(() => { f.focus(); if (f.select) f.select(); }, 30);
  });
}

export const alertBox = (title, text) => dialog({ title, body: h('div', { style: 'white-space:pre-line' }, text), dismiss: true });

export const confirmBox = (title, text, yes = t('כן'), no = t('לא')) => dialog({
  title, body: h('div', { style: 'white-space:pre-line' }, text), dismiss: false,
  buttons: [{ label: no, value: false }, { label: yes, value: true, primary: true }],
});

export async function promptNumber(title, label, value, unit = '', min = 0.1) {
  const inp = h('input', { type: 'number', step: '1', min, value: String(value), inputmode: 'decimal' });
  const ok = await dialog({
    title, dismiss: false,
    body: [h('div', {}, label), h('label', { class: 'field' }, h('span'), inp, h('i', {}, unit))],
    buttons: [{ label: t('ביטול'), value: false }, {
      label: t('אישור'), value: true, primary: true,
      validate: () => { const v = parseFloat(inp.value); return isFinite(v) && v >= min; },
    }],
  });
  return ok ? parseFloat(inp.value) : null;
}

export async function promptText(title, label, value) {
  const inp = h('input', { type: 'text', value: value || '' });
  const ok = await dialog({
    title, dismiss: false,
    body: [h('div', {}, label), inp],
    buttons: [{ label: t('ביטול'), value: false }, { label: t('אישור'), value: true, primary: true, validate: () => !!inp.value.trim() }],
  });
  return ok ? inp.value.trim() : null;
}

/** Progress dialog. Returns {set(fraction, text), close(), cancelled} */
export function progressBox(title, cancellable = true) {
  const bar = h('div');
  const txt = h('div', { class: 'info' }, '');
  const state = { cancelled: false };
  const back = h('div', { class: 'modal-back' });
  const footer = h('footer');
  if (cancellable) footer.append(h('button', { onclick: () => { state.cancelled = true; txt.textContent = t('מבטל…'); } }, t('ביטול')));
  back.append(h('div', { class: 'modal' }, h('header', {}, title), h('div', { class: 'body' }, h('div', { class: 'progress' }, bar), txt), footer));
  document.getElementById('modalRoot').append(back);
  return {
    get cancelled() { return state.cancelled; },
    set(f, text) { bar.style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`; if (text != null && !state.cancelled) txt.textContent = text; },
    close() { back.remove(); },
  };
}

let toastTimer = null;
export function toast(text, ms = 3500) {
  let el = document.querySelector('.toast');
  if (!el) { el = h('div', { class: 'toast' }); document.body.append(el); }
  el.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), ms);
}

export function pickFile(input, accept) {
  return new Promise((resolve) => {
    if (accept != null) input.accept = accept;
    input.value = '';
    const done = () => { input.removeEventListener('change', done); resolve(input.files && input.files[0] ? input.files[0] : null); };
    input.addEventListener('change', done);
    input.click();
  });
}
