// Canvas editor: view (pan/zoom), rendering loop, overlay (handles, measure lines) and pointer interaction.
import { Renderer, fitVector } from './renderer.js';
import { infoCard } from './infocard.js';
import {
  SNAP_PX, add, sub, mul, dist, edges, snapOffset, decompose, axes, avgSize, rotatePoints, normAngle, pointInQuad,
} from './geom.js';
import { MEASURE_COLORS, measureTitle } from './model.js';
import { CAPS } from './device.js';
import { t } from './i18n.js';
import { drawAllAnnotations, annoDistance, newArrow } from './annotations.js';

const ACCENT = '#ffd400', ROT = '#4caf50', EDGE = '#1ec8e6';
const PARTNER = { 0: 3, 3: 0, 1: 2, 2: 1 }, PARTNER_H = { 0: 1, 1: 0, 3: 2, 2: 3 };
const EDGES = { 0: [0, 1, 'v'], 1: [1, 2, 'u'], 2: [2, 3, 'v'], 3: [3, 0, 'u'] };

/** Scene description for the renderer (also used by the exporters). */
export function buildScene(doc, { withScreens = true, frameTick = 0 } = {}) {
  const bg = doc.bg;
  if (!bg) return { bg: null, screens: [] };
  const screens = [];
  if (withScreens) for (const s of doc.screens) {
    let tex = null, aspect = null;
    const dormant = s.media && doc.media.get(s.media)?.dormant; // video kept on a phone - show the info card
    if (s.info_mode || dormant) {
      const card = infoCard(s.name, s.active_w, s.active_h, s.ledPitch(), s.quoteRes());
      tex = { key: 'info:' + s.id, src: card, version: 0 };
    } else if (s.media && doc.media.get(s.media)) {
      const m = doc.media.get(s.media);
      if (m.kind === 'video') {
        if (m.el && m.el.readyState >= 2) {
          tex = { key: 'm:' + m.id, src: m.el, version: m.playing ? frameTick : m.version, mipmap: !m.playing };
          aspect = m.el.videoWidth / m.el.videoHeight;
        }
      } else {
        tex = { key: 'm:' + m.id, src: m.el, version: 0 };
        aspect = m.w / m.h;
      }
    }
    screens.push({
      corners: s.corners,
      bezel: [s.bezel / s.total_w, s.bezel / s.total_h],
      fit: (s.info_mode || dormant) ? [1, 1] : fitVector(s.fit, aspect, s.active_w / s.active_h),
      bright: (s.info_mode || dormant) ? 1 : s.brightness,
      tex,
    });
  }
  return { bg: { src: bg.src, w: bg.w, h: bg.h, version: bg.id }, screens };
}

export class Editor {
  constructor(app) {
    this.app = app;
    this.stage = document.getElementById('stage');
    this.gl = document.getElementById('gl');
    this.ov = document.getElementById('overlay');
    this.octx = this.ov.getContext('2d');
    this.loupe = document.getElementById('loupe');
    this.lctx = this.loupe.getContext('2d');
    this.renderer = new Renderer(this.gl);
    this.view = { zoom: 1, x: 0, y: 0 }; // image -> CSS px
    this.pointers = new Map();
    this.annoBoxes = new Map(); // text annotation hit boxes (image coords)
    this.pending = null;     // drawn line / crop frame waiting for the user's confirmation
    this.drag = null;
    this.tool = null;        // 'w' | 'h' while drawing a scale line
    this.dirty = true;
    this.playing = false;
    this.frameTick = 0;
    this.hr = CAPS.mobile ? 22 : 9;            // hit radius (CSS px)
    this.rotDist = CAPS.mobile ? 46 : 32;
    new ResizeObserver(() => this.resize()).observe(this.stage);
    this.resize();
    this.bindPointer();
    const loop = () => {
      if (this.dirty || this.playing) { this.dirty = false; this.frameTick++; this.draw(); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  get doc() { return this.app.doc; }
  invalidate() { this.dirty = true; }

  resize() {
    const r = this.stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, CAPS.mobile ? 2 : 3);
    this.dpr = dpr;
    this.cw = r.width; this.ch = r.height;
    for (const c of [this.gl, this.ov]) { c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round(r.height * dpr)); }
    if (this._fitPending) this.fitView();
    this.invalidate();
  }

  fitView() {
    const bg = this.doc.bg;
    if (!bg || this.cw < 10) { this._fitPending = true; return; }
    this._fitPending = false;
    const pad = CAPS.mobile ? 8 : 20;
    const z = Math.min((this.cw - pad * 2) / bg.w, (this.ch - pad * 2) / bg.h);
    this.view = { zoom: z, x: (this.cw - bg.w * z) / 2, y: (this.ch - bg.h * z) / 2 };
    this.invalidate();
  }

  viewCenterImg() { return this.toImg(this.cw / 2, this.ch / 2); }
  toImg(x, y) { return { x: (x - this.view.x) / this.view.zoom, y: (y - this.view.y) / this.view.zoom }; }
  toView(p) { return { x: p.x * this.view.zoom + this.view.x, y: p.y * this.view.zoom + this.view.y }; }
  evPos(e) { const r = this.ov.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  zoomAt(vx, vy, factor) {
    const z = Math.max(0.02, Math.min(40, this.view.zoom * factor));
    const p = this.toImg(vx, vy);
    this.view.zoom = z;
    this.view.x = vx - p.x * z; this.view.y = vy - p.y * z;
    this.invalidate();
  }

  // ------------------------------------------------------------------ drawing
  draw() {
    const d = this.dpr;
    const v = { zoom: this.view.zoom * d, x: this.view.x * d, y: this.view.y * d };
    this.renderer.draw(buildScene(this.doc, { frameTick: this.frameTick }), v);
    this.drawOverlay();
    if (this.loupeAt) this.drawLoupe();
  }

  drawOverlay() {
    const c = this.octx, d = this.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.ov.width, this.ov.height);
    c.setTransform(d, 0, 0, d, 0, 0);
    if (!this.doc.bg) return;
    const step = this.app.step;
    c.save();
    c.setTransform(d * this.view.zoom, 0, 0, d * this.view.zoom, d * this.view.x, d * this.view.y);
    drawAllAnnotations(c, this.doc, this.annoBoxes);
    if (this.drag && this.drag.type === 'newArrow') drawAllAnnotations(c, { bg: this.doc.bg, screens: [], annotations: [this.drag.a] });
    c.restore();
    if (step === 2 || this.app.showMeasures) {
      for (const [k, m] of Object.entries(this.doc.measures)) this.drawMeasure(k, m.p1, m.p2, m.cm);
    }
    if (step === 1) for (const [a, b] of this.app.levelLines || []) this.drawMeasure('level', a, b, null);
    if (this.drag && this.drag.type === 'newMeasure') this.drawMeasure(this.drag.kind, this.drag.p1, this.drag.p2, null);
    if (this.drag && this.drag.type === 'crop') this.drawCrop(this.drag.p1, this.drag.p2);
    if (this.pending) this.drawPending();
    if (step === 3) {
      const sel = this.app.selection;
      for (const s of this.doc.screens) {
        const pts = s.corners.map((p) => this.toView(p));
        c.beginPath(); pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y))); c.closePath();
        if (sel.has(s.id)) { c.setLineDash([6, 4]); c.strokeStyle = ACCENT; c.lineWidth = 2; } else { c.setLineDash([]); c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 1; }
        c.stroke(); c.setLineDash([]);
      }
      for (const s of this.doc.screens) if (sel.has(s.id)) this.drawHandles(s);
      const a = this.app.currentAnno;
      if (a) this.drawAnnoSelection(a);
    }
  }

  drawAnnoSelection(a) {
    const c = this.octx, r = CAPS.mobile ? 11 : 7;
    c.setLineDash([6, 4]); c.strokeStyle = ACCENT; c.lineWidth = 1.5;
    if (a.type === 'text') {
      const b = this.annoBoxes.get(a.id);
      if (b) { const p = this.toView({ x: b.x0, y: b.y0 }), q = this.toView({ x: b.x1, y: b.y1 }); c.strokeRect(p.x - 6, p.y - 4, q.x - p.x + 12, q.y - p.y + 8); }
      c.setLineDash([]);
      return;
    }
    const p1 = this.toView(a.p1), p2 = this.toView(a.p2);
    c.beginPath(); c.moveTo(p1.x, p1.y); c.lineTo(p2.x, p2.y); c.stroke(); c.setLineDash([]);
    for (const p of [p1, p2]) { c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2); c.fillStyle = 'rgba(255,255,255,.9)'; c.fill(); c.strokeStyle = ACCENT; c.lineWidth = 2; c.stroke(); }
  }

  hitAnno(ip, vp) {
    const list = this.doc.annotations || [];
    const tol = (CAPS.mobile ? 16 : 8) / this.view.zoom;
    for (let i = list.length - 1; i >= 0; i--) if (annoDistance(list[i], ip, this.annoBoxes) <= tol) return list[i];
    return null;
  }

  drawMeasure(kind, p1, p2, cm) {
    const c = this.octx, a = this.toView(p1), b = this.toView(p2), col = MEASURE_COLORS[kind];
    c.strokeStyle = '#000'; c.lineWidth = 5; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    c.strokeStyle = col; c.lineWidth = 2.5; c.stroke();
    const r = CAPS.mobile ? 7 : 5;
    for (const p of [a, b]) { c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2); c.fillStyle = '#fff'; c.fill(); c.strokeStyle = col; c.lineWidth = 2; c.stroke(); }
    const label = cm != null ? `${measureTitle(kind)}: ${fmtCm(cm)}` : measureTitle(kind);
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    c.font = 'bold 13px "Segoe UI", Arial, sans-serif';
    c.direction = document.dir === 'rtl' ? 'rtl' : 'ltr';
    const w = c.measureText(label).width + 12;
    c.fillStyle = 'rgba(0,0,0,.75)'; c.fillRect(m.x - w / 2, m.y - 26, w, 20);
    c.fillStyle = col; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(label, m.x, m.y - 16);
  }

  /** Points of the pending shape that can be dragged (line: 2 ends, rect: 4 corners). */
  pendingPoints() {
    const p = this.pending;
    if (!p) return [];
    if (p.type === 'line') return [p.p1, p.p2];
    return [p.p1, { x: p.p2.x, y: p.p1.y }, p.p2, { x: p.p1.x, y: p.p2.y }];
  }

  setPending(p) { this.pending = p; this.app.onPendingChanged(); this.invalidate(); }

  drawPending() {
    const p = this.pending, c = this.octx;
    if (p.type === 'line') this.drawMeasure(p.kind, p.p1, p.p2, null);
    else this.drawCrop(p.p1, p.p2);
    const r = CAPS.mobile ? 13 : 8;
    for (const q of this.pendingPoints()) {
      const v = this.toView(q);
      c.beginPath(); c.arc(v.x, v.y, r, 0, Math.PI * 2);
      c.fillStyle = 'rgba(255,212,0,.25)'; c.fill();
      c.lineWidth = 2.5; c.strokeStyle = ACCENT; c.stroke();
      c.beginPath(); c.arc(v.x, v.y, 2.5, 0, Math.PI * 2); c.fillStyle = ACCENT; c.fill();
    }
  }

  drawCrop(p1, p2) {
    const c = this.octx, a = this.toView({ x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y) }), b = this.toView({ x: Math.max(p1.x, p2.x), y: Math.max(p1.y, p2.y) });
    c.fillStyle = 'rgba(0,0,0,.55)';
    c.beginPath(); c.rect(0, 0, this.cw, this.ch); c.rect(a.x, a.y, b.x - a.x, b.y - a.y); c.fill('evenodd');
    c.setLineDash([6, 4]); c.strokeStyle = ACCENT; c.lineWidth = 2; c.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); c.setLineDash([]);
  }

  rotKnob(s) {
    const c0 = this.toView(s.corners[0]), c1 = this.toView(s.corners[1]);
    const tv = sub(c1, c0), l = Math.hypot(tv.x, tv.y);
    const n = l > 1e-6 ? { x: tv.y / l, y: -tv.x / l } : { x: 0, y: -1 };
    const mid = mul(add(c0, c1), 0.5);
    return { mid, knob: add(mid, mul(n, this.rotDist)) };
  }

  drawHandles(s) {
    const c = this.octx, r = CAPS.mobile ? 10 : 7;
    const { mid, knob } = this.rotKnob(s);
    c.strokeStyle = ROT; c.lineWidth = 2; c.beginPath(); c.moveTo(mid.x, mid.y); c.lineTo(knob.x, knob.y); c.stroke();
    c.beginPath(); c.arc(knob.x, knob.y, r, 0, Math.PI * 2); c.fillStyle = 'rgba(255,255,255,.92)'; c.fill(); c.stroke();
    c.beginPath(); c.arc(knob.x, knob.y, r * 0.5, 0.5, Math.PI * 1.75); c.stroke();
    if (s.custom) {
      const q = CAPS.mobile ? 8 : 6;
      for (let e = 0; e < 4; e++) {
        const [a, b] = EDGES[e];
        const p = this.toView(mul(add(s.corners[a], s.corners[b]), 0.5));
        c.fillStyle = 'rgba(255,255,255,.92)'; c.strokeStyle = EDGE; c.lineWidth = 2;
        c.fillRect(p.x - q, p.y - q, q * 2, q * 2); c.strokeRect(p.x - q, p.y - q, q * 2, q * 2);
      }
    }
    for (const p0 of s.corners) {
      const p = this.toView(p0);
      c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2); c.fillStyle = 'rgba(255,255,255,.88)'; c.fill();
      c.strokeStyle = ACCENT; c.lineWidth = 2; c.stroke();
    }
  }

  drawLoupe() {
    const L = this.loupe, ctx = this.lctx, d = this.dpr, size = L.width, mag = 2.5;
    const p = this.toView(this.loupeAt);
    const src = size / mag / 1; // CSS px region shown
    const sx = (p.x - src / 2) * d, sy = (p.y - src / 2) * d, sw = src * d;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.gl, sx, sy, sw, sw, 0, 0, size, size);
    ctx.drawImage(this.ov, sx, sy, sw, sw, 0, 0, size, size);
    ctx.strokeStyle = 'rgba(255,212,0,.9)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, size); ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2); ctx.stroke();
    // keep the loupe away from the finger
    const left = p.x > this.cw / 2;
    L.style.left = left ? '10px' : ''; L.style.right = left ? '' : '10px';
    L.hidden = false;
  }

  showLoupe(pt) { if (CAPS.mobile) { this.loupeAt = pt; } }
  hideLoupe() { this.loupeAt = null; this.loupe.hidden = true; }

  // ------------------------------------------------------------------ hit testing
  hitHandle(vp) {
    const doc = this.doc, sel = this.app.selection, R = this.hr;
    const list = doc.screens.filter((s) => sel.has(s.id)).reverse();
    for (const s of list) {
      for (let i = 0; i < 4; i++) if (dist(this.toView(s.corners[i]), vp) <= R) return { type: 'corner', s, idx: i };
      if (dist(this.rotKnob(s).knob, vp) <= R) return { type: 'rotate', s };
      if (s.custom) for (let e = 0; e < 4; e++) {
        const [a, b] = EDGES[e];
        if (dist(this.toView(mul(add(s.corners[a], s.corners[b]), 0.5)), vp) <= R) return { type: 'edge', s, edge: e };
      }
    }
    return null;
  }

  hitScreen(ip) {
    for (let i = this.doc.screens.length - 1; i >= 0; i--) if (pointInQuad(ip, this.doc.screens[i].corners)) return this.doc.screens[i];
    return null;
  }

  hitMeasureEnd(vp) {
    for (const [k, m] of Object.entries(this.doc.measures)) {
      if (dist(this.toView(m.p1), vp) <= this.hr) return { kind: k, end: 'p1' };
      if (dist(this.toView(m.p2), vp) <= this.hr) return { kind: k, end: 'p2' };
    }
    return null;
  }

  clampImg(p) { const bg = this.doc.bg; return { x: Math.max(0, Math.min(bg.w, p.x)), y: Math.max(0, Math.min(bg.h, p.y)) }; }

  snapThr() { return (CAPS.mobile ? 18 : SNAP_PX) / this.view.zoom; }
  others(exclude) { return this.doc.screens.filter((s) => !exclude.has(s.id)); }

  // ------------------------------------------------------------------ pointer interaction
  bindPointer() {
    const ov = this.ov;
    ov.addEventListener('contextmenu', (e) => e.preventDefault());
    ov.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = this.evPos(e);
      this.zoomAt(p.x, p.y, Math.pow(1.0015, -e.deltaY * (e.deltaMode === 1 ? 30 : 1)));
    }, { passive: false });
    ov.addEventListener('pointerdown', (e) => this.onDown(e));
    ov.addEventListener('pointermove', (e) => this.onMove(e));
    ov.addEventListener('pointerup', (e) => this.onUp(e));
    ov.addEventListener('pointercancel', (e) => this.onUp(e, true));
    ov.addEventListener('dblclick', (e) => {
      if (this.app.step !== 3) return;
      const s = this.hitScreen(this.toImg(...Object.values(this.evPos(e))));
      if (s) this.app.loadContentFor(s);
    });
  }

  onDown(e) {
    if (!this.doc.bg) return;
    try { this.ov.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    const vp = this.evPos(e);
    this.pointers.set(e.pointerId, vp);
    if (this.pointers.size === 2) {
      // second finger: switch to pinch zoom / pan
      this.finishDrag(true);
      const [a, b] = [...this.pointers.values()];
      this.drag = { type: 'pinch', d0: dist(a, b), m0: mul(add(a, b), 0.5), view0: { ...this.view } };
      return;
    }
    if (this.pointers.size > 2) return;
    const ip = this.toImg(vp.x, vp.y);
    const step = this.app.step;
    const panBtn = e.button === 1 || e.button === 2 || this.app.spaceDown;
    if (panBtn) { this.drag = { type: 'pan', v0: vp, view0: { ...this.view } }; return; }

    if (this.pending) {
      const pts = this.pendingPoints();
      const R = this.hr * 1.4;
      let best = -1, bd = Infinity;
      pts.forEach((q, i) => { const d = dist(this.toView(q), vp); if (d < bd) { bd = d; best = i; } });
      if (best >= 0 && bd <= R) {
        this.drag = { type: 'pendingEnd', idx: best, off: sub(pts[best], ip) };
        this.showLoupe(pts[best]);
        return;
      }
      this.drag = { type: 'pan', v0: vp, view0: { ...this.view } };
      return;
    }
    if (step === 1 && this.tool === 'level') { this.drag = { type: 'newMeasure', kind: 'level', p1: ip, p2: ip }; this.showLoupe(ip); return; }
    if (step === 1 && this.tool === 'crop') { const q = this.clampImg(ip); this.drag = { type: 'crop', p1: q, p2: q }; this.showLoupe(q); return; }
    if (step === 2) {
      if (this.tool) { this.drag = { type: 'newMeasure', kind: this.tool, p1: ip, p2: ip }; this.showLoupe(ip); return; }
      const hm = this.hitMeasureEnd(vp);
      if (hm) { this.drag = { type: 'measureEnd', ...hm, moved: false }; this.showLoupe(ip); return; }
    }
    if (step === 3 && this.tool === 'arrow') { this.drag = { type: 'newArrow', a: newArrow(this.doc.bg, ip, ip, this.app.annoColor) }; return; }
    if (step === 3 && this.tool === 'text') { this.drag = { type: 'textTap', p: ip, v0: vp }; return; }
    if (step === 3) {
      const ca = this.app.currentAnno;
      if (ca && ca.type === 'arrow') {
        for (const end of ['p1', 'p2']) if (dist(this.toView(ca[end]), vp) <= this.hr) { this.drag = { type: 'annoEnd', a: ca, end, moved: false }; this.showLoupe(ca[end]); return; }
      }
      const ha = this.hitAnno(ip, vp);
      if (ha && !this.hitHandle(vp)) {
        this.app.selectAnno(ha);
        this.drag = { type: 'annoMove', a: ha, start: ip, orig: JSON.parse(JSON.stringify(ha)), moved: false };
        return;
      }
      const hh = this.hitHandle(vp);
      if (hh) {
        const s = hh.s;
        if (hh.type === 'corner') this.drag = { type: 'corner', s, idx: hh.idx, moved: false };
        else if (hh.type === 'rotate') {
          const c = s.center();
          this.drag = { type: 'rotate', s, corners: s.corners.map((p) => ({ ...p })), angle0: s.angle, c, a0: Math.atan2(ip.y - c.y, ip.x - c.x) };
        } else {
          const [u, v] = axes(s.corners);
          this.drag = { type: 'edge', s, edge: hh.edge, start: ip, corners: s.corners.map((p) => ({ ...p })), tw: s.total_w, th: s.total_h, size: avgSize(s.corners), u, v };
        }
        if (hh.type !== 'rotate') this.showLoupe(hh.type === 'corner' ? s.corners[hh.idx] : ip);
        return;
      }
      const s = this.hitScreen(ip);
      if (s) {
        const multi = e.ctrlKey || e.metaKey || e.shiftKey;
        const sel = this.app.selection;
        if (this.app.currentAnno) this.app.selectAnno(null);
        if (multi) { sel.has(s.id) ? sel.delete(s.id) : sel.add(s.id); this.app.onSelectionChanged(); if (!sel.has(s.id)) return; }
        else if (!sel.has(s.id)) { sel.clear(); sel.add(s.id); this.app.onSelectionChanged(); }
        const group = this.doc.screens.filter((x) => sel.has(x.id));
        this.drag = { type: 'move', start: ip, group: group.map((x) => [x, x.corners.map((p) => ({ ...p }))]), moved: false };
        return;
      }
    }
    this.drag = { type: 'pan', v0: vp, view0: { ...this.view }, clickEmpty: step === 3 };
  }

  onMove(e) {
    const vp = this.evPos(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, vp);
    const dr = this.drag;
    if (!dr) { this.hoverCursor(vp); return; }
    const ip = this.toImg(vp.x, vp.y);
    const noSnap = e.altKey || !this.app.magnet;
    switch (dr.type) {
      case 'pinch': {
        const pts = [...this.pointers.values()];
        if (pts.length < 2) return;
        const [a, b] = pts, m = mul(add(a, b), 0.5);
        const z = Math.max(0.02, Math.min(40, dr.view0.zoom * dist(a, b) / Math.max(1, dr.d0)));
        const pImg = { x: (dr.m0.x - dr.view0.x) / dr.view0.zoom, y: (dr.m0.y - dr.view0.y) / dr.view0.zoom };
        this.view = { zoom: z, x: m.x - pImg.x * z, y: m.y - pImg.y * z };
        break;
      }
      case 'pan':
        if (dist(vp, dr.v0) > 3) dr.panned = true;
        this.view = { ...dr.view0, x: dr.view0.x + vp.x - dr.v0.x, y: dr.view0.y + vp.y - dr.v0.y };
        break;
      case 'newMeasure': {
        let p = ip;
        if (e.shiftKey) p = Math.abs(ip.x - dr.p1.x) > Math.abs(ip.y - dr.p1.y) ? { x: ip.x, y: dr.p1.y } : { x: dr.p1.x, y: ip.y };
        dr.p2 = p; this.showLoupe(p);
        break;
      }
      case 'newArrow': dr.a.p2 = ip; break;
      case 'textTap': break;
      case 'annoEnd': dr.a[dr.end] = ip; dr.moved = true; this.showLoupe(ip); break;
      case 'annoMove': {
        const d = sub(ip, dr.start);
        if (dr.a.type === 'arrow') { dr.a.p1 = add(dr.orig.p1, d); dr.a.p2 = add(dr.orig.p2, d); } else dr.a.p = add(dr.orig.p, d);
        dr.moved = true;
        break;
      }
      case 'pendingEnd': {
        const p = this.pending;
        let q = add(ip, dr.off);
        if (p.type === 'rect') {
          q = this.clampImg(q);
          // corners: 0 = p1, 1 = (p2.x, p1.y), 2 = p2, 3 = (p1.x, p2.y)
          if (dr.idx === 0) p.p1 = q;
          else if (dr.idx === 2) p.p2 = q;
          else if (dr.idx === 1) { p.p2 = { x: q.x, y: p.p2.y }; p.p1 = { x: p.p1.x, y: q.y }; }
          else { p.p1 = { x: q.x, y: p.p1.y }; p.p2 = { x: p.p2.x, y: q.y }; }
        } else if (dr.idx === 0) p.p1 = q; else p.p2 = q;
        this.showLoupe(q);
        break;
      }
      case 'crop': {
        dr.p2 = this.clampImg(ip); this.showLoupe(dr.p2);
        break;
      }
      case 'measureEnd': {
        const m = this.doc.measures[dr.kind];
        m[dr.end] = ip; dr.moved = true; this.showLoupe(ip);
        break;
      }
      case 'move': {
        let d = sub(ip, dr.start);
        if (!noSnap) {
          const moving = new Set(dr.group.map(([s]) => s.id));
          const oth = this.others(moving);
          if (oth.length) {
            const shifted = dr.group.map(([, cs]) => cs.map((p) => add(p, d)));
            const corr = snapOffset(shifted.flat(), shifted.flatMap((cs) => edges(cs)),
              oth.flatMap((o) => o.corners), oth.flatMap((o) => edges(o.corners)), this.snapThr());
            if (corr) d = add(d, corr);
          }
        }
        for (const [s, cs] of dr.group) s.corners = cs.map((p) => add(p, d));
        dr.moved = true;
        break;
      }
      case 'corner': {
        const s = dr.s;
        let p = ip;
        if (!noSnap) {
          const oth = this.others(new Set([s.id]));
          const corr = snapOffset([p], [], oth.flatMap((o) => o.corners), oth.flatMap((o) => edges(o.corners)), this.snapThr());
          if (corr) p = add(p, corr);
        }
        const d = sub(p, s.corners[dr.idx]);
        s.corners[dr.idx] = p;
        if (this.app.linkCorners) {
          const a = (s.angle * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a), vx = -Math.sin(a), vy = Math.cos(a);
          const du = d.x * ux + d.y * uy, dv = d.x * vx + d.y * vy;
          const jv = PARTNER[dr.idx], jh = PARTNER_H[dr.idx];
          s.corners[jv] = add(s.corners[jv], { x: dv * vx, y: dv * vy });
          s.corners[jh] = add(s.corners[jh], { x: du * ux, y: du * uy });
        }
        dr.moved = true; this.showLoupe(p);
        break;
      }
      case 'rotate': {
        let target = normAngle(dr.angle0 + ((Math.atan2(ip.y - dr.c.y, ip.x - dr.c.x) - dr.a0) * 180) / Math.PI);
        if (e.shiftKey) target = Math.round(target / 15) * 15;
        dr.s.corners = rotatePoints(dr.corners, target - dr.angle0, dr.c);
        dr.s.angle = normAngle(target);
        dr.moved = true;
        this.app.updateProps();
        break;
      }
      case 'edge': {
        const s = dr.s, [ai, bi, ax] = EDGES[dr.edge], [aw, ah] = dr.size;
        const [du, dv] = decompose(sub(ip, dr.start), dr.u, dr.v);
        let amount, shift, newSize, sign;
        if (ax === 'u') { sign = dr.edge === 1 ? 1 : -1; amount = Math.max(du * sign, -(aw - 8)); shift = mul(dr.u, amount * sign); newSize = aw + amount; }
        else { sign = dr.edge === 2 ? 1 : -1; amount = Math.max(dv * sign, -(ah - 8)); shift = mul(dr.v, amount * sign); newSize = ah + amount; }
        if (this.app.linkCorners) {
          const f = newSize / (ax === 'u' ? aw : ah);
          const [oa, ob] = EDGES[(dr.edge + 2) % 4];
          const anchor = mul(add(dr.corners[oa], dr.corners[ob]), 0.5);
          s.corners = dr.corners.map((p) => { const [a, b] = decompose(sub(p, anchor), dr.u, dr.v); return add(add(anchor, mul(dr.u, a * f)), mul(dr.v, b * f)); });
          s.setTotalSize(dr.tw * f, dr.th * f);
        } else {
          const pts = dr.corners.map((p) => ({ ...p }));
          pts[ai] = add(dr.corners[ai], shift); pts[bi] = add(dr.corners[bi], shift);
          s.corners = pts;
          if (ax === 'u') s.setTotalSize(dr.tw * newSize / aw, dr.th); else s.setTotalSize(dr.tw, dr.th * newSize / ah);
        }
        dr.moved = true; this.showLoupe(ip);
        this.app.updateProps();
        break;
      }
    }
    this.invalidate();
  }

  onUp(e, cancel = false) {
    this.pointers.delete(e.pointerId);
    if (this.drag && this.drag.type === 'pinch') {
      if (this.pointers.size === 0) this.drag = null;
      return;
    }
    if (this.pointers.size === 0) this.finishDrag(cancel);
  }

  finishDrag(cancel) {
    const dr = this.drag;
    this.drag = null;
    this.hideLoupe();
    if (!dr) return;
    if (dr.type === 'pan' && dr.clickEmpty && !dr.panned && (this.app.selection.size || this.app.currentAnno)) {
      this.app.selection.clear(); this.app.selectAnno(null); this.app.onSelectionChanged();
    }
    if (dr.type === 'crop') {
      const w = Math.abs(dr.p1.x - dr.p2.x) * this.view.zoom, h = Math.abs(dr.p1.y - dr.p2.y) * this.view.zoom;
      if (!cancel && w > 10 && h > 10) this.setPending({ type: 'rect', kind: 'crop', p1: dr.p1, p2: dr.p2 });
    } else if (dr.type === 'newMeasure') {
      if (!cancel && dist(this.toView(dr.p1), this.toView(dr.p2)) > 8) this.setPending({ type: 'line', kind: dr.kind, p1: dr.p1, p2: dr.p2 });
    } else if (dr.type === 'newArrow') {
      this.app.setTool(null);
      if (!cancel && dist(this.toView(dr.a.p1), this.toView(dr.a.p2)) > 12) this.app.addAnnotation(dr.a);
    } else if (dr.type === 'textTap') {
      this.app.setTool(null);
      if (!cancel) this.app.placeText(dr.p);
    } else if (dr.type === 'pendingEnd') {
      this.app.onPendingChanged();
    } else if (dr.moved) {
      this.app.onEdited(dr.type === 'measureEnd');
    }
    this.invalidate();
  }

  hoverCursor(vp) {
    if (CAPS.mobile || !this.doc.bg) return;
    let cur = 'grab';
    if (this.app.step === 1 && this.tool) cur = 'crosshair';
    if (this.app.step === 3 && this.tool) cur = 'crosshair';
    else if (this.app.step === 3 && this.hitAnno(this.toImg(vp.x, vp.y), vp)) cur = 'move';
    if (this.pending) cur = this.pendingPoints().some((q) => dist(this.toView(q), vp) <= this.hr * 1.4) ? 'move' : 'grab';
    if (this.app.step === 2) cur = this.tool ? 'crosshair' : this.hitMeasureEnd(vp) ? 'move' : 'grab';
    if (this.app.step === 3) {
      const hh = this.hitHandle(vp);
      if (hh) cur = hh.type === 'corner' ? 'crosshair' : hh.type === 'rotate' ? 'alias' : (EDGES[hh.edge][2] === 'u' ? 'ew-resize' : 'ns-resize');
      else if (this.hitScreen(this.toImg(vp.x, vp.y))) cur = 'move';
    }
    this.ov.style.cursor = cur;
  }
}

export function fmtCm(cm) {
  return cm >= 100 ? t('{0} מ׳', (cm / 100).toFixed(2)) : t('{0} ס״מ', cm.toFixed(1));
}
