// Info card shown on a screen (name, size, aspect ratio, content resolution).
import { t, isRTL } from './i18n.js';
import { dims, g, aspectText, ledResolution, contentResolution } from './geom.js';

export function resolutionText(aw, ah, pitch = null, res = null) {
  if (res) {
    const tail = pitch ? t('Pitch {0} מ״מ, מההצעה', g(pitch)) : t('מההצעה');
    return `${dims(res[0], res[1], 0, ' px')}  (${tail})`;
  }
  if (pitch) {
    const [rw, rh] = ledResolution(aw, ah, pitch);
    return t('{0}  (Pitch {1} מ״מ)', dims(rw, rh, 0, ' px'), g(pitch));
  }
  const [rw, rh] = contentResolution(aw, ah);
  return t('{0}  (טלוויזיה 4K)', dims(rw, rh, 0, ' px'));
}

const cache = new Map();

export function infoCard(name, aw, ah, pitch = null, res = null) {
  const key = JSON.stringify([name, aw.toFixed(2), ah.toFixed(2), pitch, res]);
  if (cache.has(key)) return cache.get(key);
  let W, H;
  if (aw >= ah) { W = 1600; H = Math.max(64, Math.round((W * ah) / aw)); } else { H = 1600; W = Math.max(64, Math.round((H * aw) / ah)); }
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const p = cv.getContext('2d');
  const grad = p.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#1d3557'); grad.addColorStop(1, '#0b132b');
  p.fillStyle = grad; p.fillRect(0, 0, W, H);
  const bw = Math.max(3, Math.floor(Math.min(W, H) / 60));
  p.strokeStyle = '#4fc3f7'; p.lineWidth = bw;
  p.strokeRect(bw * 2, bw * 2, W - bw * 4, H - bw * 4);

  const diag = Math.hypot(aw, ah) / 2.54;
  let lines;
  if (pitch) {
    lines = [
      [name, 1.0, true, '#ffffff'],
      [t('גודל: {0} ס״מ  (≈{1}")', dims(aw, ah), diag.toFixed(0)), 0.5, false, '#e0e0e0'],
      [`Aspect Ratio: ${aspectText(aw, ah)}`, 0.5, false, '#4fc3f7'],
      [t('רזולוציה: {0}', resolutionText(aw, ah, pitch, res)), 0.5, false, '#ffd400'],
    ];
  } else {
    lines = [
      [name, 1.0, true, '#ffffff'],
      [t("{0} אינץ'", g(Math.round(diag * 10) / 10)), 0.75, true, '#ffd400'],
      [t('גודל: {0} ס״מ', dims(aw, ah)), 0.5, false, '#e0e0e0'],
    ];
  }
  p.direction = isRTL() ? 'rtl' : 'ltr';
  p.textAlign = 'center';
  p.textBaseline = 'middle';
  const font = (b, rel, bold) => `${bold ? 'bold ' : ''}${Math.max(6, Math.floor(b * rel))}px "Segoe UI", Arial, sans-serif`;
  let base = H * 0.17, heights;
  for (let i = 0; i < 40; i++) {
    let maxW = 0;
    heights = lines.map(([text, rel, bold]) => {
      p.font = font(base, rel, bold);
      maxW = Math.max(maxW, p.measureText(text).width);
      return Math.floor(base * rel) * 1.33 * 1.25;
    });
    if (maxW <= W * 0.86 && heights.reduce((a, b) => a + b, 0) <= H * 0.82) break;
    base *= 0.9;
  }
  let y = (H - heights.reduce((a, b) => a + b, 0)) / 2;
  lines.forEach(([text, rel, bold, color], i) => {
    p.font = font(base, rel, bold);
    p.fillStyle = color;
    p.fillText(text, W / 2, y + heights[i] / 2);
    y += heights[i];
  });
  if (cache.size > 50) cache.clear();
  cache.set(key, cv);
  return cv;
}
