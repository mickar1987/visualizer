// Document model: background, scale measurements, screens, media pool, undo history.
import { DEFAULT_PITCH, rectCorners, rotatePoints, normAngle, center, axes, decompose, add, mul, sub, dist } from './geom.js';
import { t } from './i18n.js';

let uid = 1;
export const newId = (p = 'id') => `${p}${Date.now().toString(36)}${(uid++).toString(36)}`;

export class Screen {
  constructor(name, activeW, activeH, bezel = 0) {
    this.id = newId('s');
    this.name = name;
    this.active_w = activeW;
    this.active_h = activeH;
    this.bezel = bezel;
    this.fit = 'fill';
    this.brightness = 1.0;
    this.angle = 0;
    this.custom = false;       // created "by size (cm)" -> may be resized afterwards
    this.pitch = DEFAULT_PITCH;
    this.info_mode = false;
    this.model = '';
    this.res_override = null;
    this.res_for = null;
    this.quote_idx = null;
    this.media = null;         // media id
    this.corners = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
  }
  get total_w() { return this.active_w + 2 * this.bezel; }
  get total_h() { return this.active_h + 2 * this.bezel; }
  center() { return center(this.corners); }
  setRect(ctr, wPx, hPx) { this.corners = rectCorners(ctr, wPx, hPx, this.angle); }
  rotateTo(deg) {
    deg = normAngle(deg);
    this.corners = rotatePoints(this.corners, deg - this.angle, this.center());
    this.angle = deg;
  }
  setTotalSize(tw, th) {
    this.active_w = Math.max(1, tw - 2 * this.bezel);
    this.active_h = Math.max(1, th - 2 * this.bezel);
  }
  /** Change the display size in cm; the quad is scaled around its centre along its own axes. */
  resizeActive(aw, ah) {
    const fw = (aw + 2 * this.bezel) / this.total_w, fh = (ah + 2 * this.bezel) / this.total_h;
    const [u, v] = axes(this.corners), c = this.center();
    this.corners = this.corners.map((p) => {
      const [a, b] = decompose(sub(p, c), u, v);
      return add(add(c, mul(u, a * fw)), mul(v, b * fh));
    });
    this.active_w = aw; this.active_h = ah;
  }
  ledPitch() { return this.custom ? this.pitch : null; }
  setQuoteRes(res) {
    this.res_override = res ? [...res] : null;
    this.res_for = res ? [this.active_w, this.active_h, this.pitch] : null;
  }
  quoteRes() {
    if (!this.res_override || !this.res_for) return null;
    const [w, h, p] = this.res_for;
    if (Math.abs(w - this.active_w) > 0.05 || Math.abs(h - this.active_h) > 0.05 || Math.abs(p - this.pitch) > 1e-6) return null;
    return this.res_override;
  }
  toDict() {
    const d = {};
    for (const k of ['id', 'name', 'active_w', 'active_h', 'bezel', 'fit', 'brightness', 'angle', 'custom', 'pitch',
      'info_mode', 'model', 'res_override', 'res_for', 'quote_idx', 'media']) d[k] = this[k];
    d.corners = this.corners.map((c) => [c.x, c.y]);
    return d;
  }
  static fromDict(d) {
    const s = new Screen(d.name, d.active_w, d.active_h, d.bezel);
    for (const k of Object.keys(d)) if (k !== 'corners') s[k] = d[k];
    s.corners = d.corners.map(([x, y]) => ({ x, y }));
    return s;
  }
}

export const MEASURE_COLORS = { w: '#ff5252', h: '#40c4ff', level: '#e040fb' };
export const measureTitle = (k) => (k === 'w' ? t('רוחב') : k === 'h' ? t('גובה') : t('קו ייחוס'));

export class Doc {
  constructor() {
    this.bgPool = new Map();  // id -> {id, src (canvas/bitmap), w, h, name, blob, mime}
    this.media = new Map();   // id -> {id, kind, name, blob, mime, el, w, h, duration, hasAudio, version}
    this.reset();
  }
  reset() {
    this.bgId = null;
    this.measures = {};       // kind -> {p1, p2, cm}
    this.screens = [];
    this.projectName = '';
    this.history = [];
    this.hpos = -1;
  }
  get bg() { return this.bgId ? this.bgPool.get(this.bgId) : null; }

  scale() {
    const m = this.measures, w = m.w, h = m.h;
    if (!w && !h) return null;
    const ppc = (x) => dist(x.p1, x.p2) / x.cm;
    return [ppc(w || h), ppc(h || w)];
  }

  snapshot() {
    return JSON.stringify({ bgId: this.bgId, measures: this.measures, screens: this.screens.map((s) => s.toDict()) });
  }
  restore(json) {
    const st = JSON.parse(json);
    this.bgId = st.bgId;
    this.measures = st.measures;
    this.screens = st.screens.map(Screen.fromDict);
  }
  commit() {
    const snap = this.snapshot();
    if (this.history[this.hpos] === snap) return false;
    this.history = this.history.slice(0, this.hpos + 1);
    this.history.push(snap);
    if (this.history.length > 80) this.history.shift();
    this.hpos = this.history.length - 1;
    return true;
  }
  canUndo() { return this.hpos > 0; }
  canRedo() { return this.hpos < this.history.length - 1; }
  undo() { if (this.canUndo()) { this.restore(this.history[--this.hpos]); return true; } return false; }
  redo() { if (this.canRedo()) { this.restore(this.history[++this.hpos]); return true; } return false; }
}
