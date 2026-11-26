// LED Quote hand-off (same request schema as the desktop app's --quote request.json).
//   Web:  index.html#quote=<base64url(JSON)>   or   index.html?quote_url=<https URL of the JSON>
//   or open the request .json file from the menu.
import { t } from './i18n.js';
import { dims, g } from './geom.js';

const num = (d, key, required = false) => {
  const v = d[key];
  if (v == null || v === '') { if (required) throw new Error(t("חסר שדה '{0}'", key)); return null; }
  const n = Number(v);
  if (!isFinite(n)) throw new Error(t("ערך לא תקין בשדה '{0}': {1}", key, JSON.stringify(v)));
  if (n <= 0) { if (required) throw new Error(t("השדה '{0}' חייב להיות חיובי", key)); return null; }
  return n;
};

export function parseRequest(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(t('מבנה קובץ הבקשה לא תקין'));
  const schema = data.schema ?? 1;
  if (!Number.isInteger(schema) || schema > 1) throw new Error(t('גרסת קובץ ({0}) חדשה מדי לתוכנה הזו - יש לעדכן את ההדמיה', schema));
  const screens = (data.screens || []).map((d, i) => {
    if (!d || typeof d !== 'object') throw new Error(t('מסך {0}: מבנה לא תקין', i + 1));
    let w, h;
    try { w = num(d, 'width_mm', true); h = num(d, 'height_mm', true); } catch (e) { throw new Error(t('מסך {0}: {1}', i + 1, e.message)); }
    const rw = num(d, 'res_w'), rh = num(d, 'res_h'), qty = num(d, 'qty');
    return {
      name: String(d.name || t('מסך {0}', i + 1)), model: String(d.model || ''),
      width_cm: w / 10, height_cm: h / 10, pitch: num(d, 'pitch_mm'),
      res: rw && rh ? [Math.round(rw), Math.round(rh)] : null, qty: Math.max(1, Math.round(qty || 1)), added: 0,
    };
  });
  return { client: String(data.client || ''), project: String(data.project || ''), background: String(data.background || ''), screens, raw: data };
}

export const quoteTitle = (q) => [q.client, q.project].filter(Boolean).join(' / ');

export function quoteLabel(q) {
  let s = q.name;
  if (q.model) s += ` (${q.model})`;
  s += t(' — {0} מ״מ', dims(q.width_cm * 10, q.height_cm * 10, null));
  if (q.pitch) s += `, P${g(q.pitch)}`;
  return s;
}

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
}
export function encodeRequest(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = ''; bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Request passed in the page URL, or null. */
export async function requestFromUrl() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const qs = new URLSearchParams(location.search);
  if (hash.get('quote')) return parseRequest(JSON.parse(b64urlDecode(hash.get('quote'))));
  if (qs.get('quote_url')) {
    const r = await fetch(qs.get('quote_url'));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return parseRequest(await r.json());
  }
  return null;
}
