// Background photo operations: rotate by any angle, crop, auto-crop of the black rotation borders.
// Each background keeps `valid`: the polygon (image coords) that holds real photo pixels, or null = all of it.
import { newId } from './model.js';

const fullRect = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
export const applyM = (M, p) => ({ x: M[0] * p.x + M[1] * p.y + M[2], y: M[3] * p.x + M[4] * p.y + M[5] });

/** Rotate the current background by deg (positive = clockwise). The canvas grows so nothing is cut off.
 *  Returns {id, M} - M is the affine map old -> new image coords (row-major 2x3). */
export function rotateBackground(doc, deg) {
  const bg = doc.bg, w = bg.w, h = bg.h;
  const a = (deg * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
  const exact = Math.abs(((deg % 90) + 90) % 90) < 1e-9;
  let nw = Math.abs(w * cs) + Math.abs(h * sn), nh = Math.abs(w * sn) + Math.abs(h * cs);
  nw = Math.max(1, Math.round(nw)); nh = Math.max(1, Math.round(nh));
  // p' = R (p - c) + c'
  const M = [cs, -sn, nw / 2 - (cs * w / 2 - sn * h / 2), sn, cs, nh / 2 - (sn * w / 2 + cs * h / 2)];
  const cv = document.createElement('canvas');
  cv.width = nw; cv.height = nh;
  const c = cv.getContext('2d');
  c.fillStyle = '#000'; c.fillRect(0, 0, nw, nh);
  c.imageSmoothingQuality = 'high';
  c.setTransform(M[0], M[3], M[1], M[4], M[2], M[5]);
  c.drawImage(bg.src, 0, 0);
  const valid = exact && !bg.valid ? null : (bg.valid || fullRect(w, h)).map((p) => applyM(M, p));
  const id = newId('bg');
  doc.bgPool.set(id, { id, src: cv, w: nw, h: nh, name: bg.name, blob: null, mime: 'image/jpeg', valid });
  return { id, M };
}

export function cropBackground(doc, x0, y0, x1, y1) {
  const bg = doc.bg;
  x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
  x1 = Math.min(bg.w, Math.round(x1)); y1 = Math.min(bg.h, Math.round(y1));
  const w = x1 - x0, h = y1 - y0;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(bg.src, x0, y0, w, h, 0, 0, w, h);
  const M = [1, 0, -x0, 0, 1, -y0];
  let valid = bg.valid ? bg.valid.map((p) => applyM(M, p)) : null;
  if (valid && fullRect(w, h).every((p) => insidePoly(p, valid, -0.5))) valid = null;
  const id = newId('bg');
  doc.bgPool.set(id, { id, src: cv, w, h, name: bg.name, blob: null, mime: 'image/jpeg', valid });
  return { id, M };
}

/** Point inside a convex polygon. margin > 0: must be that far inside; margin <= 0: tolerance for points on an edge. */
function insidePoly(p, poly, margin = 0) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x, ey = b.y - a.y, l = Math.hypot(ex, ey) || 1;
    const cr = (ex * (p.y - a.y) - ey * (p.x - a.x)) / l;
    if (margin <= 0 && Math.abs(cr) <= -margin + 1e-9) continue; // on the edge (within tolerance)
    const s = Math.sign(cr) || 1;
    if (!sign) sign = s;
    if (s !== sign || Math.abs(cr) < margin) return false;
  }
  return true;
}

/** Largest all-true axis-aligned rectangle in a boolean grid. Returns [x0, y0, x1, y1] (exclusive). */
function largestRect(valid, w, h) {
  const heights = new Int32Array(w);
  let best = [0, 0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) heights[x] = valid[y * w + x] ? heights[x] + 1 : 0;
    const stack = [];
    for (let x = 0; x <= w; x++) {
      const cur = x < w ? heights[x] : 0;
      let start = x;
      while (stack.length && stack[stack.length - 1][1] >= cur) {
        const [sx, sh] = stack.pop();
        const area = sh * (x - sx);
        if (area > best[0]) best = [area, sx, y - sh + 1, x, y + 1];
        start = sx;
      }
      stack.push([start, cur]);
    }
  }
  return best.slice(1);
}

/** Largest rectangle with only real photo pixels, or null when there is nothing to crop. */
export function largestValidRect(bg, workSize = 420) {
  if (!bg.valid) return null;
  const f = Math.min(1, workSize / Math.max(bg.w, bg.h));
  const sw = Math.max(1, Math.round(bg.w * f)), sh = Math.max(1, Math.round(bg.h * f));
  const cv = document.createElement('canvas');
  cv.width = sw; cv.height = sh;
  const c = cv.getContext('2d', { willReadFrequently: true });
  c.fillStyle = '#fff';
  c.beginPath();
  bg.valid.forEach((p, i) => (i ? c.lineTo(p.x * f, p.y * f) : c.moveTo(p.x * f, p.y * f)));
  c.closePath(); c.fill();
  const d = c.getImageData(0, 0, sw, sh).data;
  const grid = new Uint8Array(sw * sh);
  for (let i = 0; i < grid.length; i++) grid[i] = d[i * 4 + 3] >= 250 ? 1 : 0;
  const [x0, y0, x1, y1] = largestRect(grid, sw, sh);
  if (x1 <= x0 || y1 <= y0) return null;
  const fx = bg.w / sw, fy = bg.h / sh;
  let X0 = Math.ceil(x0 * fx) + 1, Y0 = Math.ceil(y0 * fy) + 1, X1 = Math.floor(x1 * fx) - 1, Y1 = Math.floor(y1 * fy) - 1;
  // make sure no black pixel is left (interpolated edge pixels count as black too)
  for (let i = 0; i < 60; i++) {
    if (X1 - X0 < 2 || Y1 - Y0 < 2) return null;
    const corners = [{ x: X0, y: Y0 }, { x: X1, y: Y0 }, { x: X1, y: Y1 }, { x: X0, y: Y1 }];
    if (corners.every((p) => insidePoly(p, bg.valid, 1.5))) return [X0, Y0, X1, Y1];
    X0++; Y0++; X1--; Y1--;
  }
  return null;
}

/** Average direction (degrees, clockwise-positive, in [-90, 90)) of undirected lines. */
export function meanLineAngle(lines) {
  let sx = 0, sy = 0;
  for (const [p1, p2] of lines) {
    const a = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    sx += Math.cos(2 * a); sy += Math.sin(2 * a);
  }
  return (0.5 * Math.atan2(sy, sx) * 180) / Math.PI;
}
