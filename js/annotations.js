// Things drawn on top of the visualization (also in exported images / videos):
//  - per screen: dimension arrows with the width / height in cm (+ optional resolution)
//  - free arrows and text placed anywhere on the photo
// Everything is drawn in image coordinates, so the screen view and the export look the same.
import { t } from './i18n.js';
import { add, sub, mul, dist, unit, g, ledResolution, contentResolution, center } from './geom.js';
import { newId, defaultDim } from './model.js';

export const ANNO_COLORS = ['#ffd400', '#ffffff', '#ff5252', '#40c4ff', '#69f0ae', '#ff9800', '#000000'];
export const DEFAULT_DIM = defaultDim;

const FONT = '"Segoe UI", Arial, sans-serif';
const imgDiag = (bg) => Math.hypot(bg.w, bg.h);

/** Base size (image px) for a new free annotation. */
export function defaultSize(bg, type) { return type === 'text' ? imgDiag(bg) * 0.025 : imgDiag(bg) * 0.0045; }

export function newArrow(bg, p1, p2, color = '#ffd400') { return { id: newId('a'), type: 'arrow', p1, p2, color, size: defaultSize(bg, 'arrow') }; }
export function newText(bg, p, text, color = '#ffd400') { return { id: newId('a'), type: 'text', p, text, color, size: defaultSize(bg, 'text') }; }

/** Content pixels of a screen along width / height (quote value, LED pitch or 4K TV). */
function resolutionOf(s) {
  const q = s.quoteRes && s.quoteRes();
  if (q) return q;
  const p = s.ledPitch();
  return p ? ledResolution(s.active_w, s.active_h, p) : contentResolution(s.active_w, s.active_h);
}

function arrowHead(ctx, tip, dir, len, wid) {
  const n = { x: -dir.y, y: dir.x };
  const b = sub(tip, mul(dir, len));
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(b.x + n.x * wid, b.y + n.y * wid);
  ctx.lineTo(b.x - n.x * wid, b.y - n.y * wid);
  ctx.closePath();
  ctx.fill();
}

/** Text with a dark outline so it reads on any background. */
function haloText(ctx, text, x, y, size, color, angle = 0, align = 'center', baseline = 'middle') {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.font = `bold ${size}px ${FONT}`;
  ctx.textAlign = align; ctx.textBaseline = baseline;
  ctx.direction = 'rtl';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, size * 0.18);
  ctx.strokeStyle = color === '#000000' ? 'rgba(255,255,255,.85)' : 'rgba(0,0,0,.8)';
  ctx.strokeText(text, 0, 0);
  ctx.fillStyle = color;
  ctx.fillText(text, 0, 0);
  const w = ctx.measureText(text).width;
  ctx.restore();
  return w;
}

/** One dimension line along the edge a->b, pushed outward (away from the screen centre). */
function drawDim(ctx, a, b, ctr, label, color, base) {
  const dir = unit(sub(b, a));
  let n = { x: -dir.y, y: dir.x };
  const mid = mul(add(a, b), 0.5);
  if ((mid.x - ctr.x) * n.x + (mid.y - ctr.y) * n.y < 0) n = mul(n, -1); // outward
  const off = base * 1.3, lw = Math.max(1.5, base * 0.09);
  const A = add(a, mul(n, off)), B = add(b, mul(n, off));
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineCap = 'round';
  // extension lines from the screen corners
  ctx.globalAlpha = 0.75; ctx.lineWidth = lw * 0.6;
  ctx.beginPath();
  for (const [p, q] of [[a, A], [b, B]]) { const s0 = add(p, mul(n, base * 0.25)), s1 = add(q, mul(n, base * 0.35)); ctx.moveTo(s0.x, s0.y); ctx.lineTo(s1.x, s1.y); }
  ctx.stroke();
  ctx.globalAlpha = 1;
  // dark under-stroke for contrast, then the arrow
  const head = base * 0.55;
  const A2 = add(A, mul(dir, head * 0.9)), B2 = sub(B, mul(dir, head * 0.9));
  ctx.lineWidth = lw + Math.max(1.5, base * 0.06); ctx.strokeStyle = 'rgba(0,0,0,.55)';
  ctx.beginPath(); ctx.moveTo(A2.x, A2.y); ctx.lineTo(B2.x, B2.y); ctx.stroke();
  ctx.lineWidth = lw; ctx.strokeStyle = color;
  ctx.beginPath(); ctx.moveTo(A2.x, A2.y); ctx.lineTo(B2.x, B2.y); ctx.stroke();
  arrowHead(ctx, A, mul(dir, -1), head, head * 0.42);
  arrowHead(ctx, B, dir, head, head * 0.42);
  ctx.restore();
  // label beyond the line, along it, never upside down
  let ang = Math.atan2(dir.y, dir.x);
  if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
  const at = add(mul(add(A, B), 0.5), mul(n, base * 1.05)); // clear gap between the arrow and the text
  haloText(ctx, label, at.x, at.y, base, color, ang);
}

/** Dimension arrows of one screen. */
export function drawScreenDims(ctx, s, bg) {
  const d = s.dim;
  if (!d || (!d.w && !d.h)) return;
  const c = s.corners, ctr = center(c);
  const sw = (dist(c[0], c[1]) + dist(c[3], c[2])) / 2, sh = (dist(c[0], c[3]) + dist(c[1], c[2])) / 2;
  const D = imgDiag(bg);
  const base = Math.min(D * 0.03, Math.max(D * 0.012, Math.max(sw, sh) * 0.06));
  const res = (d.wRes || d.hRes) ? resolutionOf(s) : null;
  const cm = (v) => t('{0} ס״מ', g(Math.round(v * 10) / 10));
  // "1920 px" is a left-to-right run inside Hebrew text: isolate it so it never flips
  const px = (n) => `  |  ⁦${n} px⁩`;
  if (d.w) {
    const [a, b] = d.wPos === 'bottom' ? [c[3], c[2]] : [c[0], c[1]];
    drawDim(ctx, a, b, ctr, cm(s.active_w) + (d.wRes ? px(res[0]) : ''), d.color, base);
  }
  if (d.h) {
    const [a, b] = d.hPos === 'left' ? [c[0], c[3]] : [c[1], c[2]];
    drawDim(ctx, a, b, ctr, cm(s.active_h) + (d.hRes ? px(res[1]) : ''), d.color, base);
  }
}

/** Free arrow / text. Returns its hit box for text (image coords). */
export function drawAnno(ctx, a) {
  if (a.type === 'arrow') {
    const dir = unit(sub(a.p2, a.p1)), L = dist(a.p1, a.p2);
    const lw = a.size, head = Math.min(L * 0.45, lw * 4.5);
    const end = sub(a.p2, mul(dir, head * 0.85));
    ctx.save(); ctx.lineCap = 'round';
    ctx.strokeStyle = a.color === '#000000' ? 'rgba(255,255,255,.7)' : 'rgba(0,0,0,.55)';
    ctx.lineWidth = lw + Math.max(2, lw * 0.6);
    ctx.beginPath(); ctx.moveTo(a.p1.x, a.p1.y); ctx.lineTo(end.x, end.y); ctx.stroke();
    ctx.strokeStyle = a.color; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(a.p1.x, a.p1.y); ctx.lineTo(end.x, end.y); ctx.stroke();
    ctx.fillStyle = a.color;
    arrowHead(ctx, a.p2, dir, head, head * 0.5);
    ctx.restore();
    return null;
  }
  const w = haloText(ctx, a.text, a.p.x, a.p.y, a.size, a.color);
  return { x0: a.p.x - w / 2, y0: a.p.y - a.size * 0.65, x1: a.p.x + w / 2, y1: a.p.y + a.size * 0.65 };
}

/** Everything (dimension arrows + free annotations). ctx must already map image coords. */
export function drawAllAnnotations(ctx, doc, boxes = null) {
  if (!doc.bg) return;
  for (const s of doc.screens) drawScreenDims(ctx, s, doc.bg);
  for (const a of doc.annotations || []) {
    const box = drawAnno(ctx, a);
    if (boxes) boxes.set(a.id, box);
  }
}

export const hasAnnotations = (doc) => (doc.annotations || []).length > 0 || doc.screens.some((s) => s.dim && (s.dim.w || s.dim.h));

/** Distance (image px) from p to an annotation, for picking. */
export function annoDistance(a, p, boxes) {
  if (a.type === 'arrow') {
    const ab = sub(a.p2, a.p1), l2 = ab.x * ab.x + ab.y * ab.y;
    const tt = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.p1.x) * ab.x + (p.y - a.p1.y) * ab.y) / l2));
    return Math.max(0, dist(p, add(a.p1, mul(ab, tt))) - a.size);
  }
  const b = boxes && boxes.get(a.id);
  if (!b) return dist(p, a.p);
  const dx = Math.max(b.x0 - p.x, 0, p.x - b.x1), dy = Math.max(b.y0 - p.y, 0, p.y - b.y1);
  return Math.hypot(dx, dy);
}
