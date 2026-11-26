// Geometry helpers (ported from the desktop app: scene_items.py / compositor.py)
export const DEFAULT_PITCH = 2.5; // mm
export const SNAP_PX = 12;        // magnet distance in screen pixels

export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
export const len = (v) => Math.hypot(v.x, v.y);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const unit = (v) => { const l = len(v); return l > 1e-9 ? { x: v.x / l, y: v.y / l } : { x: 1, y: 0 }; };

export function normAngle(a) {
  a = ((a + 180) % 360 + 360) % 360 - 180;
  return a === -180 ? 180 : a;
}

export function closestOnSeg(p, a, b) {
  const ab = sub(b, a);
  const l2 = ab.x * ab.x + ab.y * ab.y;
  if (l2 < 1e-9) return { ...a };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2));
  return add(a, mul(ab, t));
}

export const edges = (c) => [0, 1, 2, 3].map((i) => [c[i], c[(i + 1) % 4]]);

/** Correction vector that snaps moving geometry to targets, or null.
 *  Corner-to-corner wins; otherwise corner-to-edge (both directions). */
export function snapOffset(points, movEdges, targetPts, targetEdges, thr) {
  let best = null;
  const consider = (v) => { const d = len(v); if (d < thr && (!best || d < best.d)) best = { d, v }; };
  for (const p of points) for (const q of targetPts) consider(sub(q, p));
  if (best) return best.v;
  for (const p of points) for (const [a, b] of targetEdges) consider(sub(closestOnSeg(p, a, b), p));
  for (const q of targetPts) for (const [a, b] of movEdges) consider(sub(q, closestOnSeg(q, a, b)));
  return best ? best.v : null;
}

/** Solve p = a*u + b*v (u, v need not be orthogonal). */
export function decompose(p, u, v) {
  const det = u.x * v.y - u.y * v.x;
  if (Math.abs(det) < 1e-9) return [p.x * u.x + p.y * u.y, p.x * v.x + p.y * v.y];
  return [(p.x * v.y - p.y * v.x) / det, (u.x * p.y - u.y * p.x) / det];
}

/** Rotate points around c. Positive = clockwise on screen (y axis points down). */
export function rotatePoints(points, deg, c) {
  const a = (deg * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
  return points.map((p) => {
    const dx = p.x - c.x, dy = p.y - c.y;
    return { x: c.x + dx * cs - dy * sn, y: c.y + dx * sn + dy * cs };
  });
}

export const center = (c) => ({ x: (c[0].x + c[1].x + c[2].x + c[3].x) / 4, y: (c[0].y + c[1].y + c[2].y + c[3].y) / 4 });

export function axes(c) {
  const u = unit(add(sub(c[1], c[0]), sub(c[2], c[3])));
  const v = unit(add(sub(c[3], c[0]), sub(c[2], c[1])));
  return [u, v];
}

export function avgSize(c) {
  return [(dist(c[1], c[0]) + dist(c[2], c[3])) / 2, (dist(c[3], c[0]) + dist(c[2], c[1])) / 2];
}

export function rectCorners(ctr, w, h, angle) {
  const hw = w / 2, hh = h / 2;
  const pts = [
    { x: ctr.x - hw, y: ctr.y - hh }, { x: ctr.x + hw, y: ctr.y - hh },
    { x: ctr.x + hw, y: ctr.y + hh }, { x: ctr.x - hw, y: ctr.y + hh },
  ];
  return rotatePoints(pts, angle, ctr);
}

export function pointInQuad(p, c) {
  // works for convex and simple concave quads (ray casting)
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = c[i], b = c[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Homography mapping the unit square (0,0),(1,0),(1,1),(0,1) to the quad c[0..3].
 *  Returns a row-major 3x3 array. */
export function squareToQuad(c) {
  const [p0, p1, p2, p3] = c;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  let g = 0, h = 0;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(dx3) > 1e-12 || Math.abs(dy3) > 1e-12) {
    if (Math.abs(den) > 1e-12) {
      g = (dx3 * dy2 - dx2 * dy3) / den;
      h = (dx1 * dy3 - dx3 * dy1) / den;
    }
  }
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + h * p3.x, cc = p0.x;
  const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + h * p3.y, f = p0.y;
  return [a, b, cc, d, e, f, g, h, 1];
}

export function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) return null;
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

export function aspectText(w, h) {
  const x = (9 * w) / h;
  let s = x.toFixed(1);
  if (s.endsWith('.0')) s = s.slice(0, -2);
  return `${s}:9`;
}

/** Content pixels for a TV screen as if produced in 4K (short side = 2160). */
export function contentResolution(w, h) {
  const r = w / h;
  if (Math.abs(r - 16 / 9) / (16 / 9) < 0.01) return [3840, 2160];
  if (Math.abs(r - 9 / 16) / (9 / 16) < 0.01) return [2160, 3840];
  let pw, ph;
  if (w >= h) { ph = 2160; pw = (2160 * w) / h; } else { pw = 2160; ph = (2160 * h) / w; }
  return [Math.round(pw / 2) * 2, Math.round(ph / 2) * 2];
}

export function ledResolution(awCm, ahCm, pitchMm) {
  const p = Math.max(0.01, pitchMm);
  return [Math.max(1, Math.round((awCm * 10) / p)), Math.max(1, Math.round((ahCm * 10) / p))];
}

export const LRO = '‭', PDF = '‬';
export const g = (v) => String(+(+v).toFixed(4)); // like python {:g} for typical values
export function dims(w, h, digits = 1, suffix = '') {
  const f = (v) => (digits == null ? g(v) : (+v).toFixed(digits));
  return `${LRO}${f(w)} × ${f(h)}${suffix}${PDF}`;
}
