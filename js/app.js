// Main controller of the web visualizer.
import { t, LANG, isRTL, setLanguage, translateDom } from './i18n.js';
import { CAPS, MOBILE, detectMobile, deviceSetting, setDeviceSetting } from './device.js';
import { Doc, Screen, measureTitle, MEASURE_COLORS } from './model.js';
import { Editor, fmtCm } from './editor.js';
import { dims, g, aspectText, normAngle } from './geom.js';
import { rotateBackground, cropBackground, largestValidRect, meanLineAngle, applyM } from './imageops.js';
import { resolutionText } from './infocard.js';
import { addBackground, addMedia, isVideoFile, isImageFile } from './media.js';
import { exportImage, exportVideo, videoExportSupported } from './exporter.js';
import { saveProject, openProject, PROJECT_EXT, saveProjectImage, containsProject } from './project.js';
import * as OD from './onedrive.js';
import { parseRequest, requestFromUrl, quoteTitle, quoteLabel } from './quote.js';
import { $, $$, h, dialog, alertBox, confirmBox, promptNumber, progressBox, toast, pickFile, promptText } from './ui.js';
import * as store from './store.js';
import { applyIcons } from './icons.js';
import { MobileUI } from './mobile.js';

const ASPECTS = [['16:9', 16, 9], ['21:9', 21, 9], ['32:9', 32, 9], ['4:3', 4, 3], ['1:1', 1, 1]];
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const safeName = (s) => (s || '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80);
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };

class App {
  constructor() {
    this.doc = new Doc();
    this.step = 1;
    this.selection = new Set();
    this.primary = null;
    this.linkCorners = false;
    this.magnet = true;
    this.showMeasures = false;
    this.quote = null;
    this.quoteSel = 0;
    this.savedPos = 0;
    document.documentElement.lang = LANG;
    document.documentElement.dir = isRTL() ? 'rtl' : 'ltr';
    document.body.classList.toggle('is-mobile', MOBILE);
    document.body.classList.toggle('caps-video', CAPS.video);
    document.body.classList.toggle('caps-quote', CAPS.quote);
    document.body.classList.toggle('caps-cloud', OD.configured());
    translateDom();
    applyIcons();
    document.title = t('הדמיה למסכים');
    this.editor = new Editor(this);
    this.mobile = MOBILE ? new MobileUI(this) : null;
    this.bind();
    this.doc.commit();
    this.savedPos = this.doc.hpos;
    this.goToStep(1);
    this.boot();
  }

  // ------------------------------------------------------------------ boot
  async boot() {
    try {
      const acc = await OD.completeRedirect();
      if (acc !== null) toast(t('מחובר ל-OneDrive: {0}', acc || ''));
    } catch (e) { alertBox('OneDrive', e.message); }
    let req = null;
    if (CAPS.quote) {
      try { req = await requestFromUrl(); } catch (e) { alertBox(t('בקשת הדמיה מההצעה'), e.message); }
    }
    let restore = false;
    try { restore = sessionStorage.getItem('viz.restore') === '1'; sessionStorage.removeItem('viz.restore'); } catch { /* ignore */ }
    if (restore) {
      const last = await store.loadLast().catch(() => null);
      if (last && last.blob) await this.openProjectBlob(last.blob, last.name, !last.saved);
    } else if (!req) {
      const auto = await store.loadAutosave().catch(() => null);
      if (auto && auto.blob && (await confirmBox(t('שחזור עבודה'), t('נמצאה עבודה שלא נשמרה מ-{0}.\nלשחזר אותה?', new Date(auto.time).toLocaleString()), t('שחזר'), t('התחל מחדש')))) {
        await this.openProjectBlob(auto.blob, auto.name, true);
      } else if (auto) store.clearAutosave();
    } else this.loadQuote(req);
    history.replaceState(null, '', location.pathname);
  }

  // ------------------------------------------------------------------ helpers
  get current() { return this.doc.screens.find((s) => s.id === this.primary) || null; }
  setStatus(text, mobileToast = false) {
    $('#statusText').textContent = text;
    if (mobileToast && MOBILE) toast(text);
  }
  get dirty() { return this.doc.hpos !== this.savedPos; }

  commit() {
    if (this.doc.commit()) store.scheduleAutosave(this);
    this.updateUI();
  }

  onEdited() {
    this.commit();
  }

  // ------------------------------------------------------------------ steps
  goToStep(n) {
    if (n >= 2 && !this.doc.bg) { this.setStatus(t('יש לטעון תמונה תחילה'), true); n = 1; }
    if (n >= 3 && !this.doc.scale()) { this.setStatus(t('יש לסמן קנה מידה (רוחב ו/או גובה ידוע) לפני הוספת מסך.'), true); n = Math.min(n, 2); }
    if (this.editor.playing && n !== 3) this.stopPlay();
    this.step = n;
    this.setTool(null);
    if (n !== 3) { this.selection.clear(); }
    $$('.step').forEach((b) => {
      const k = +b.dataset.step;
      b.classList.toggle('active', k === n);
      b.classList.toggle('done', k < n);
    });
    $$('.pane').forEach((p) => p.classList.toggle('active', +p.dataset.pane === n));
    const hints = {
      1: t('שלב 1: טען תמונה מהשטח.'),
      2: t('שלב 2: סמן קו על אובייקט שמידתו ידועה.'),
      3: t('שלב 3: הוסף מסכים וגרור אותם למקום. פינות = פרספקטיבה, ידית ירוקה = סיבוב.'),
    };
    this.setStatus(hints[n]);
    this.updateUI();
    this.editor.invalidate();
  }

  setTool(kind) {
    this.editor.pending = null;
    $('#pendingBar').hidden = true;
    this.editor.tool = kind;
    this.editor && this.editor.invalidate();
    $$('.tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === kind));
    const hint = $('#toolHint');
    this.levelLines = [];
    if (kind) {
      hint.textContent = t('גרור קו לאורך ה{0} הידוע. Shift = קו ישר.', measureTitle(kind));
      if (MOBILE) hint.textContent = t('גרור קו לאורך ה{0} הידוע', measureTitle(kind));
      if (kind === 'level') hint.textContent = t('קו ייחוס 1 מתוך 2: גרור קו לאורך משהו שאמור להיות אופקי (רצפה, תקרה, מדף)');
      if (kind === 'crop') hint.textContent = t('גרור מלבן על האזור שרוצים להשאיר');
      hint.hidden = false;
      if (this.mobile) this.mobile.closeSheet();
    } else hint.hidden = true;
    if (this.mobile) this.mobile.refresh();
  }

  // ------------------------------------------------------------------ UI refresh
  updateUI() {
    const doc = this.doc, bg = doc.bg, sc = doc.scale();
    $('#empty').hidden = !!bg;
    $('#btnUndo').disabled = !doc.canUndo();
    $('#btnRedo').disabled = !doc.canRedo();
    $('#projTitle').textContent = [...new Set([this.quote && quoteTitle(this.quote), doc.projectName].filter(Boolean))].filter((x, i, a) => !a.some((y, j) => j !== i && y.includes(x))).join(' · ') + (this.dirty && bg ? ' •' : '');
    $('#lblBg').textContent = bg ? t('✓ תמונה: {0}  ({1})', bg.name, dims(bg.w, bg.h, 0)) : t('לא נטענה תמונה');
    for (const id of ['#btnRotL', '#btnRotR', '#btnRotAny', '#btnLevel', '#btnCrop', '#btnNext1']) $(id).disabled = !bg;
    $('#btnAutoCrop').disabled = !(bg && bg.valid);
    $('#btnNext2').disabled = !sc;
    $('#lblScale').textContent = sc ? t('קנה מידה: {0} פיקסלים לס״מ', g(Math.round(((sc[0] + sc[1]) / 2) * 100) / 100)) : t('קנה מידה לא הוגדר');
    this.renderMeasures();
    this.renderScreenList();
    this.renderQuote();
    this.updateProps();
    const hasVid = doc.screens.some((s) => !s.info_mode && s.media && doc.media.get(s.media)?.kind === 'video' && doc.media.get(s.media).el);
    $('#btnPlay').disabled = !hasVid;
    $('#btnExpImg').disabled = !bg;
    $('#btnExpVid').disabled = !bg;
    $('#btnLink').classList.toggle('on', this.linkCorners);
    $('#btnMagnet').classList.toggle('on', this.magnet);
    if (this.mobile) this.mobile.refresh();
  }

  renderMeasures() {
    const box = $('#measureList');
    box.replaceChildren();
    for (const kind of ['w', 'h']) {
      const m = this.doc.measures[kind];
      if (!m) continue;
      const inp = h('input', { type: 'number', step: '1', min: '0.1', value: g(m.cm), inputmode: 'decimal' });
      inp.addEventListener('change', () => {
        const v = parseFloat(inp.value);
        if (isFinite(v) && v > 0) { m.cm = v; this.commit(); this.editor.invalidate(); }
      });
      box.append(h('div', { class: 'measure' },
        h('span', { class: 'dot', style: `background:${MEASURE_COLORS[kind]}` }), h('span', {}, measureTitle(kind) + ':'), inp, h('i', {}, t('ס״מ')),
        h('button', { class: 'icon', title: t('מחק'), onclick: () => { delete this.doc.measures[kind]; this.commit(); this.editor.invalidate(); } }, '✕')));
    }
    if (Object.keys(this.doc.measures).length) {
      box.append(h('p', { class: 'hint' }, t('אפשר לגרור את קצות הקווים לדיוק.')));
    }
  }

  renderScreenList() {
    const box = $('#screenList');
    box.replaceChildren();
    for (const s of this.doc.screens) {
      box.append(h('div', {
        class: 'item' + (this.selection.has(s.id) ? ' sel' : ''),
        onclick: (e) => {
          if (e.ctrlKey || e.metaKey) { this.selection.has(s.id) ? this.selection.delete(s.id) : this.selection.add(s.id); }
          else { this.selection.clear(); this.selection.add(s.id); }
          this.primary = s.id;
          this.onSelectionChanged();
        },
      }, h('span', {}, s.name), h('small', {}, dims(s.active_w, s.active_h) + ' ' + t('ס״מ'))));
    }
  }

  onSelectionChanged() {
    if (!this.selection.has(this.primary)) this.primary = [...this.selection].pop() || null;
    this.updateUI();
    this.editor.invalidate();
  }

  updateProps() {
    const s = this.current, box = $('#props');
    box.hidden = !s || this.step !== 3;
    if (!s) return;
    const n = this.selection.size;
    $('#lblMulti').textContent = n > 1 ? t('(נבחרו {0} מסכים - גרירה מזיזה את כולם)', n) : '';
    const set = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };
    set('#edName', s.name);
    set('#spW', g(Math.round(s.active_w * 10) / 10));
    set('#spH', g(Math.round(s.active_h * 10) / 10));
    set('#spPitch', g(s.pitch));
    set('#spBezel', g(s.bezel));
    set('#spAngle', g(Math.round(s.angle * 10) / 10));
    $('#cbFit').value = s.fit;
    set('#slBright', Math.round(s.brightness * 100));
    $('#lblBright').textContent = `${Math.round(s.brightness * 100)}%`;
    $('#customBox').hidden = !s.custom;
    $('#btnInfo').classList.toggle('on', s.info_mode);
    const m = s.media && this.doc.media.get(s.media);
    $('#lblContent').textContent = m ? (m.kind === 'video' ? '🎬 ' : '🖼 ') + m.name + (m.dormant ? t(' (סרטון - מוצג רק במחשב)') : '') : t('ללא תוכן');
    $('#btnClear').disabled = !m;
    const diag = Math.hypot(s.active_w, s.active_h) / 2.54;
    $('#lblSize').textContent = (s.model ? t('דגם: {0}', s.model) + '\n' : '') +
      t('גודל: {0} ס״מ\nאלכסון: ≈{1}"\nיחס (Aspect Ratio): {2}\nרזולוציה לתוכן: {3}', dims(s.active_w, s.active_h), diag.toFixed(0), aspectText(s.active_w, s.active_h), resolutionText(s.active_w, s.active_h, s.ledPitch(), s.quoteRes()));
  }

  // ------------------------------------------------------------------ binding
  bind() {
    const on = (sel, ev, fn) => $(sel).addEventListener(ev, fn);
    $$('.step').forEach((b) => b.addEventListener('click', () => this.goToStep(+b.dataset.step)));
    // top bar
    on('#btnNew', 'click', () => this.newProject());
    on('#btnOpen', 'click', () => this.openProjectDialog());
    on('#btnSave', 'click', () => this.saveProjectLocal());
    on('#btnCloud', 'click', () => this.cloudMenu());
    on('#btnQuoteFile', 'click', () => this.openQuoteFile());
    on('#btnUndo', 'click', () => this.undo());
    on('#btnRedo', 'click', () => this.redo());
    on('#btnSettings', 'click', () => this.settingsDialog());
    on('#btnMenu', 'click', () => this.mobileMenu());
    // step 1
    on('#btnLoadBg', 'click', () => this.loadBgDialog());
    on('#btnCamera', 'click', () => this.loadBgDialog(true));
    on('#btnEmptyLoad', 'click', () => this.loadBgDialog());
    on('#btnEmptyCamera', 'click', () => this.loadBgDialog(true));
    on('#btnEmptyOpen', 'click', () => this.openProjectDialog());
    on('#btnBgCloud', 'click', () => this.loadBgFromCloud());
    on('#btnRotL', 'click', () => this.rotateBg(-90));
    on('#btnRotR', 'click', () => this.rotateBg(90));
    on('#btnRotAny', 'click', () => this.rotateAngleDialog());
    on('#btnPendOk', 'click', () => this.confirmPending());
    on('#btnPendCancel', 'click', () => this.cancelPending());
    on('#btnLevel', 'click', () => this.setTool(this.editor.tool === 'level' ? null : 'level'));
    on('#btnCrop', 'click', () => this.setTool(this.editor.tool === 'crop' ? null : 'crop'));
    on('#btnAutoCrop', 'click', () => this.autoCrop());
    on('#chkAutoCrop', 'change', (e) => LS.set('viz.autoCrop', e.target.checked));
    $('#chkAutoCrop').checked = LS.get('viz.autoCrop', true);
    on('#btnNext1', 'click', () => this.goToStep(2));
    // step 2
    on('#btnMW', 'click', () => this.setTool(this.editor.tool === 'w' ? null : 'w'));
    on('#btnMH', 'click', () => this.setTool(this.editor.tool === 'h' ? null : 'h'));
    on('#btnNext2', 'click', () => this.goToStep(3));
    // step 3
    on('#btnAdd', 'click', () => this.addScreenDialog());
    on('#btnLink', 'click', () => { this.linkCorners = !this.linkCorners; this.updateUI(); this.setStatus(this.linkCorners ? t('שמירת יחס פעילה: גרירת פינה מזיזה גם את הפינות הסמוכות') : t('שמירת יחס כבויה')); });
    on('#btnMagnet', 'click', () => { this.magnet = !this.magnet; this.updateUI(); });
    on('#btnQuoteAdd', 'click', () => this.addQuoteScreens(true));
    on('#btnQuoteAll', 'click', () => this.addQuoteScreens(false));
    on('#btnInfo', 'click', () => { const s = this.current; if (s) { s.info_mode = !s.info_mode; this.commit(); this.editor.invalidate(); } });
    on('#btnContent', 'click', () => this.current && this.loadContentFor(this.current));
    on('#btnContentCloud', 'click', () => this.current && this.loadContentFromCloud(this.current));
    on('#btnClear', 'click', () => { const s = this.current; if (s) { s.media = null; s.info_mode = true; this.commit(); this.editor.invalidate(); } });
    on('#btnReset', 'click', () => this.resetScreenRect());
    on('#btnDup', 'click', () => this.duplicateScreen());
    on('#btnDel', 'click', () => this.deleteScreens());
    on('#btnPlay', 'click', () => (this.editor.playing ? this.stopPlay() : this.startPlay()));
    on('#btnFitView', 'click', () => this.editor.fitView());
    on('#btnExpImg', 'click', () => this.exportImageFlow());
    on('#btnExpVid', 'click', () => this.exportVideoFlow());
    on('#btnSaveCloud', 'click', () => this.saveProjectCloud());
    this.bindProps();
    // mobile
    this.bindKeys();
    this.bindDrop();
    window.addEventListener('beforeunload', (e) => { if (this.dirty && this.doc.bg) { store.autosaveNow(this); e.preventDefault(); e.returnValue = ''; } });
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.doc.bg) store.autosaveNow(this); });
  }


  bindProps() {
    const num = (id, fn) => {
      const el = $(id);
      el.addEventListener('input', () => { const v = parseFloat(el.value); if (isFinite(v) && this.current) { fn(this.current, v, el); this.editor.invalidate(); } });
      el.addEventListener('change', () => this.commit());
    };
    $('#edName').addEventListener('change', (e) => { const s = this.current; if (s) { s.name = e.target.value.trim() || s.name; this.commit(); this.editor.invalidate(); } });
    num('#spW', (s, v) => { if (!s.custom || v < 1) return; const hh = this.linkCorners ? s.active_h * v / s.active_w : s.active_h; s.resizeActive(v, hh); this.syncField('#spH', s.active_h); this.updateSizeLabel(); });
    num('#spH', (s, v) => { if (!s.custom || v < 1) return; const ww = this.linkCorners ? s.active_w * v / s.active_h : s.active_w; s.resizeActive(ww, v); this.syncField('#spW', s.active_w); this.updateSizeLabel(); });
    num('#spPitch', (s, v) => { if (s.custom && v >= 0.3) { s.pitch = v; this.updateSizeLabel(); } });
    num('#spBezel', (s, v) => { if (v >= 0) { s.bezel = v; this.updateSizeLabel(); } });
    num('#spAngle', (s, v) => s.rotateTo(v));
    $('#cbFit').addEventListener('change', (e) => { const s = this.current; if (s) { s.fit = e.target.value; this.commit(); this.editor.invalidate(); } });
    const br = $('#slBright');
    br.addEventListener('input', () => { const s = this.current; if (s) { s.brightness = br.value / 100; $('#lblBright').textContent = `${br.value}%`; this.editor.invalidate(); } });
    br.addEventListener('change', () => this.commit());
  }
  syncField(id, v) { $(id).value = g(Math.round(v * 10) / 10); }
  updateSizeLabel() {
    const keep = document.activeElement;
    this.updateProps();
    if (keep && keep.focus) keep.focus();
  }

  bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (document.querySelector('.modal-back')) return;
      const inField = /INPUT|SELECT|TEXTAREA/.test(e.target.tagName);
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === ' ' && !inField) { this.spaceDown = true; }
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); return; }
      if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); this.redo(); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); this.saveProjectLocal(); return; }
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); this.openProjectDialog(); return; }
      if (inField) return;
      if (this.step === 3) {
        if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); this.doc.screens.forEach((s) => this.selection.add(s.id)); this.onSelectionChanged(); }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteScreens(); }
        if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); this.duplicateScreen(); }
        const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (arrows[e.key] && this.selection.size) {
          e.preventDefault();
          const k = (e.shiftKey ? 10 : 1) / this.editor.view.zoom, [dx, dy] = arrows[e.key];
          for (const s of this.doc.screens) if (this.selection.has(s.id)) s.corners = s.corners.map((p) => ({ x: p.x + dx * k, y: p.y + dy * k }));
          this.editor.invalidate();
          clearTimeout(this._nudge); this._nudge = setTimeout(() => this.commit(), 400);
        }
      }
      if (this.editor.pending && e.key === 'Enter') { e.preventDefault(); this.confirmPending(); return; }
      if (this.editor.pending && e.key === 'Escape') { this.cancelPending(); return; }
      if (e.key === 'Escape') { this.setTool(null); this.selection.clear(); this.onSelectionChanged(); }
    });
    document.addEventListener('keyup', (e) => { if (e.key === ' ') this.spaceDown = false; });
    document.addEventListener('paste', async (e) => {
      if (/INPUT|TEXTAREA/.test(e.target.tagName)) return;
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
      if (!item) return;
      e.preventDefault();
      const f = item.getAsFile();
      const file = new File([f], `paste_${stamp()}.png`, { type: f.type });
      if (this.step === 3 && this.current) this.setContent(this.current, file);
      else this.setBackground(file);
    });
  }

  bindDrop() {
    const st = $('#stage');
    st.addEventListener('dragover', (e) => { e.preventDefault(); st.classList.add('dragover'); });
    st.addEventListener('dragleave', () => st.classList.remove('dragover'));
    st.addEventListener('drop', async (e) => {
      e.preventDefault(); st.classList.remove('dragover');
      const f = e.dataTransfer.files[0];
      if (!f) return;
      if (f.name.toLowerCase().endsWith(PROJECT_EXT) || f.name.toLowerCase().endsWith('.zip')) return this.openProjectBlob(f, f.name);
      if (f.name.toLowerCase().endsWith('.json') && CAPS.quote) return this.openQuoteFile(f);
      if (this.step === 3) {
        const p = this.editor.evPos(e), s = this.editor.hitScreen(this.editor.toImg(p.x, p.y));
        if (s) return this.setContent(s, f);
      }
      if (isImageFile(f)) this.setBackground(f);
    });
  }

  // ------------------------------------------------------------------ undo
  undo() { if (this.doc.undo()) this.afterRestore(); }
  redo() { if (this.doc.redo()) this.afterRestore(); }
  afterRestore() {
    const ids = new Set(this.doc.screens.map((s) => s.id));
    for (const id of [...this.selection]) if (!ids.has(id)) this.selection.delete(id);
    if (!ids.has(this.primary)) this.primary = [...this.selection].pop() || null;
    if (this.step >= 3 && !this.doc.scale()) this.goToStep(2);
    if (!this.doc.bg) this.goToStep(1);
    store.scheduleAutosave(this);
    this.updateUI();
    this.editor.invalidate();
  }

  // ------------------------------------------------------------------ step 1: photo
  async loadBgDialog(camera = false) {
    const f = await pickFile(camera ? $('#fileCamera') : $('#fileImage'), 'image/*');
    if (f) this.setBackground(f);
  }

  async setBackground(file) {
    if (await containsProject(file).catch(() => false)) {
      const open = await confirmBox(t('פרויקט הדמיה'), t('התמונה הזו כוללת פרויקט הדמיה שמור.\nלפתוח את הפרויקט (עם המסכים) או להשתמש בה רק כתמונה מהשטח?'), t('פתח פרויקט'), t('רק תמונה'));
      if (open) { if (await this.confirmDiscard()) this.openProjectBlob(file, file.name); return; }
    }
    if (this.doc.bg && (this.doc.screens.length || Object.keys(this.doc.measures).length)) {
      if (!(await confirmBox(t('החלפת תמונה'), t('להחליף את התמונה מהשטח?\nקנה המידה והמסכים יישארו במקומם בפיקסלים.')))) return;
    }
    this.setStatus(t('טוען תמונה…'));
    try {
      const firstBg = !this.doc.bg;
      this.doc.bgId = await addBackground(this.doc, file, file.name || 'photo.jpg');
      if (firstBg && !this.doc.projectName) this.doc.projectName = safeName((file.name || '').replace(/\.[^.]+$/, '')) || '';
      this.editor.fitView();
      this.commit();
      this.setStatus(t('התמונה נטענה. אפשר לסובב אותה ואז להמשיך לקנה מידה.'));
    } catch (e) {
      alertBox(t('טעינת תמונה'), t('לא ניתן לפתוח את התמונה:\n{0}', e.message || e));
    }
  }

  /** A line / crop frame was drawn (or one of its points moved): wait for "Confirm". */
  onPendingChanged() {
    const p = this.editor.pending;
    $('#pendingBar').hidden = !p || MOBILE;
    if (p) $('#toolHint').textContent = p.type === 'rect' ? t('גרור את הפינות לדיוק, ואז "אישור"') : t('גרור את הנקודות לדיוק, ואז "אישור"');
    if (this.mobile) this.mobile.refresh();
  }

  confirmPending() {
    const p = this.editor.pending;
    if (!p) return;
    this.editor.pending = null;
    $('#pendingBar').hidden = true;
    this.editor.invalidate();
    if (p.kind === 'level') return this.onLevelLine(p.p1, p.p2);
    this.setTool(null);
    if (p.kind === 'crop') return this.onCropDrawn(p.p1, p.p2);
    return this.onMeasureDrawn(p.kind, p.p1, p.p2);
  }

  /** Throw the drawn shape away; the tool stays on so it can be drawn again. */
  cancelPending() {
    if (!this.editor.pending) return;
    this.editor.pending = null;
    $('#pendingBar').hidden = true;
    const kind = this.editor.tool;
    const keepLines = this.levelLines || [];
    this.setTool(kind);
    if (kind === 'level') {
      this.levelLines = keepLines;
      if (keepLines.length) $('#toolHint').textContent = t('קו ייחוס 2 מתוך 2: גרור קו נוסף שאמור להיות אופקי');
      if (this.mobile) this.mobile.refresh();
    }
    this.editor.invalidate();
  }

  /** New background from rotate/crop: move measures and screens along (M = old -> new). */
  applyBgTransform({ id, M }, dAngle) {
    const doc = this.doc;
    doc.bgId = id;
    for (const m of Object.values(doc.measures)) { m.p1 = applyM(M, m.p1); m.p2 = applyM(M, m.p2); }
    for (const s of doc.screens) { s.corners = s.corners.map((p) => applyM(M, p)); s.angle = normAngle(s.angle + dAngle); }
    this.editor.fitView();
  }

  get autoCropOn() { return $('#chkAutoCrop').checked; }

  /** Rotate the photo. deg > 0 = clockwise. Then (optionally) crop away the black corners. */
  rotateBg(deg, quiet = false) {
    if (!this.doc.bg || Math.abs(deg) < 1e-6) return;
    this.applyBgTransform(rotateBackground(this.doc, deg), deg);
    let msg = t('התמונה סובבה ב-{0}°.', deg.toFixed(2));
    if (this.autoCropOn && this.doc.bg.valid && this.autoCrop(true)) msg += t(' השוליים השחורים נחתכו אוטומטית.');
    this.commit();
    if (!quiet) this.setStatus(msg, true);
    return msg;
  }

  async rotateAngleDialog() {
    if (!this.doc.bg) return;
    const deg = await promptNumber(t('סיבוב תמונה'), t('זווית במעלות (חיובי = עם כיוון השעון):'), 0, '°', -360);
    if (deg != null) this.rotateBg(deg);
  }

  /** Crop to the largest rectangle without black (rotation) borders. */
  autoCrop(quiet = false) {
    const bg = this.doc.bg;
    if (!bg) return false;
    if (!bg.valid) { if (!quiet) this.setStatus(t('אין שוליים שחורים לחיתוך'), true); return false; }
    const r = largestValidRect(bg);
    if (!r) { if (!quiet) this.setStatus(t('לא נמצא אזור לחיתוך'), true); return false; }
    this.applyBgTransform(cropBackground(this.doc, ...r), 0);
    if (!quiet) { this.commit(); this.setStatus(t('נחתך אוטומטית ל-{0}', dims(r[2] - r[0], r[3] - r[1], 0, ' px')), true); }
    return true;
  }

  onCropDrawn(p1, p2) {
    const x0 = Math.min(p1.x, p2.x), y0 = Math.min(p1.y, p2.y), x1 = Math.max(p1.x, p2.x), y1 = Math.max(p1.y, p2.y);
    if (x1 - x0 < 10 || y1 - y0 < 10) return;
    this.applyBgTransform(cropBackground(this.doc, x0, y0, x1, y1), 0);
    this.commit();
    this.setStatus(t('נחתך ל-{0}', dims(this.doc.bg.w, this.doc.bg.h, 0, ' px')), true);
  }

  onLevelLine(p1, p2) {
    this.levelLines.push([p1, p2]);
    this.editor.invalidate();
    if (this.levelLines.length < 2) {
      $('#toolHint').textContent = t('קו ייחוס 2 מתוך 2: גרור קו נוסף שאמור להיות אופקי');
      if (this.mobile) this.mobile.refresh();
      return;
    }
    const lines = this.levelLines;
    this.setTool(null);
    const angles = lines.map((ln) => meanLineAngle([ln]));
    const mean = meanLineAngle(lines); // middle angle between the two reference lines
    if (Math.abs(mean) < 0.01) return this.setStatus(t('הקווים כבר ישרים - אין צורך בסיבוב'), true);
    const cropped = this.rotateBg(-mean, true).includes(t(' השוליים השחורים נחתכו אוטומטית.'));
    this.setStatus(t('יושר לפי 2 קווים ({0}° ו-{1}°): סובב ב-{2}°', angles[0].toFixed(2), angles[1].toFixed(2), (-mean).toFixed(2))
      + (cropped ? t('  - השוליים השחורים נחתכו') : ''), true);
  }

  // ------------------------------------------------------------------ step 2: scale
  async onMeasureDrawn(kind, p1, p2) {
    const prev = this.doc.measures[kind];
    const cm = await promptNumber(t('{0} ידוע', measureTitle(kind)), t('מה האורך האמיתי של הקו שסימנת (בס״מ)?'), prev ? prev.cm : 100, t('ס״מ'));
    if (cm == null) { this.editor.invalidate(); return; }
    this.doc.measures[kind] = { p1, p2, cm };
    this.commit();
    this.editor.invalidate();
    this.setStatus(t('קנה המידה עודכן. אפשר להוסיף מסך.'), true);
  }

  // ------------------------------------------------------------------ step 3: screens
  async addScreenDialog() {
    if (this.step !== 3) return;
    const sc = this.doc.scale();
    if (!sc) return alertBox(t('קנה מידה'), t('יש לסמן קנה מידה (רוחב ו/או גובה ידוע) לפני הוספת מסך.'));
    const prev = LS.get('viz.addScreen', {});
    const num = (v, step = 1, min = 0) => h('input', { type: 'number', step: String(step), min: String(min), value: String(v), inputmode: 'decimal' });
    const name = h('input', { type: 'text', value: t('מסך {0}', this.doc.screens.length + 1) });
    const mode = h('select', {}, h('option', { value: 'diag' }, t("לפי אלכסון (אינץ')")), h('option', { value: 'cm' }, t('לפי מידות (ס״מ)')));
    mode.value = prev.mode || 'diag';
    const diag = num(prev.diag || 65, 1, 5);
    const aspect = h('select', {}, ...ASPECTS.map((a, i) => h('option', { value: i }, a[0])));
    aspect.value = prev.aspect || 0;
    const wcm = num(prev.w || 300, 1, 1), hcm = num(prev.h || 170, 1, 1), pitch = num(prev.pitch || 2.5, 0.1, 0.3);
    const orient = h('select', {}, h('option', { value: 'l' }, t('אופקי (שוכב)')), h('option', { value: 'p' }, t('אנכי (עומד)')));
    orient.value = prev.orient || 'l';
    const bezel = num(prev.bezel ?? 1, 1, 0);
    const info = h('div', { class: 'info pre' });
    const field = (label, el, unit = '') => h('label', { class: 'field' }, h('span', {}, label), el, h('i', {}, unit));
    const pDiag = h('div', {}, field(t('אלכסון:'), diag, t("אינץ'")), field(t('יחס:'), aspect));
    const pCm = h('div', {}, field(t('רוחב תצוגה:'), wcm, t('ס״מ')), field(t('גובה תצוגה:'), hcm, t('ס״מ')), field('Pitch:', pitch, t('מ״מ')));
    const values = () => {
      let w, hh;
      if (mode.value === 'diag') {
        const [, a, b] = ASPECTS[+aspect.value];
        const d = (parseFloat(diag.value) || 1) * 2.54;
        hh = d / Math.sqrt((a / b) ** 2 + 1); w = (hh * a) / b;
      } else { w = parseFloat(wcm.value) || 1; hh = parseFloat(hcm.value) || 1; }
      if ((orient.value === 'p' && w > hh) || (orient.value === 'l' && hh > w)) [w, hh] = [hh, w];
      return { name: name.value.trim() || t('מסך'), w, h: hh, bezel: Math.max(0, parseFloat(bezel.value) || 0), custom: mode.value === 'cm', pitch: Math.max(0.3, parseFloat(pitch.value) || 2.5) };
    };
    const refresh = () => {
      pDiag.hidden = mode.value !== 'diag'; pCm.hidden = mode.value === 'diag';
      const v = values(), b = v.bezel;
      info.textContent = t('תצוגה: {0} ס״מ\nכולל מסגרת: {1} ס״מ\nיחס: {2}\nרזולוציה לתוכן: {3}', dims(v.w, v.h), dims(v.w + 2 * b, v.h + 2 * b), aspectText(v.w, v.h), resolutionText(v.w, v.h, v.custom ? v.pitch : null))
        + (v.custom ? t('\nאפשר לשנות את הגודל גם אחרי היצירה') : '');
    };
    const body = h('div', { style: 'display:flex;flex-direction:column;gap:8px' }, field(t('שם:'), name), field(t('הגדרת גודל:'), mode), pDiag, pCm, field(t('כיוון:'), orient), field(t('מסגרת:'), bezel, t('ס״מ')), info);
    body.addEventListener('input', refresh); body.addEventListener('change', refresh);
    refresh();
    const ok = await dialog({ title: t('הוספת מסך'), body, dismiss: false, autofocus: !MOBILE, buttons: [{ label: t('ביטול'), value: false }, { label: t('הוסף'), value: true, primary: true }] });
    if (!ok) return;
    LS.set('viz.addScreen', { mode: mode.value, diag: diag.value, aspect: aspect.value, w: wcm.value, h: hcm.value, pitch: pitch.value, orient: orient.value, bezel: bezel.value });
    const v = values();
    const s = new Screen(v.name, v.w, v.h, v.bezel);
    s.custom = v.custom; s.pitch = v.pitch; s.info_mode = true;
    s.setRect(this.editor.viewCenterImg(), s.total_w * sc[0], s.total_h * sc[1]);
    this.doc.screens.push(s);
    this.select(s);
    this.commit();
    if (this.mobile) this.mobile.closeSheet();
    this.setStatus(t('גרור את המסך למקומו. פינות = פרספקטיבה, ידית ירוקה = סיבוב.'));
  }

  select(s) { this.selection.clear(); this.selection.add(s.id); this.primary = s.id; this.onSelectionChanged(); }

  resetScreenRect() {
    const s = this.current, sc = this.doc.scale();
    if (s && sc) { s.setRect(s.center(), s.total_w * sc[0], s.total_h * sc[1]); this.commit(); this.editor.invalidate(); }
  }

  duplicateScreen() {
    const src = this.current;
    if (!src) return;
    const d = src.toDict();
    const s = Screen.fromDict(d);
    s.id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    s.name = src.name + t(' (עותק)');
    s.quote_idx = null;
    const off = 30 / this.editor.view.zoom;
    s.corners = s.corners.map((p) => ({ x: p.x + off, y: p.y + off }));
    this.doc.screens.push(s);
    this.select(s);
    this.commit();
  }

  deleteScreens() {
    if (!this.selection.size) return;
    this.doc.screens = this.doc.screens.filter((s) => !this.selection.has(s.id));
    this.selection.clear(); this.primary = null;
    this.commit();
    this.editor.invalidate();
  }

  contentAccept() { return CAPS.video ? 'image/*,video/*' : 'image/*'; }

  async loadContentFor(s) {
    const f = await pickFile($('#fileContent'), this.contentAccept());
    if (f) this.setContent(s, f);
  }

  async setContent(s, file) {
    if (isVideoFile(file) && !CAPS.video) return alertBox(t('תוכן'), t('סרטונים נתמכים בגרסת המחשב. בטלפון אפשר להציג תמונות.'));
    if (!isVideoFile(file) && !isImageFile(file)) return alertBox(t('תוכן'), t('סוג קובץ לא נתמך'));
    this.setStatus(t('טוען תוכן…'));
    try {
      const m = await addMedia(this.doc, file, file.name || 'content', () => this.editor.invalidate());
      if (m.kind === 'video' && this.editor.playing) { m.el.currentTime = 0; m.el.play(); m.playing = true; }
      s.media = m.id;
      s.info_mode = false;
      this.select(s);
      this.commit();
      this.editor.invalidate();
      this.setStatus(t('התוכן נטען: {0}', file.name || ''));
    } catch (e) {
      alertBox(t('תוכן'), t('לא ניתן לפתוח את הקובץ:\n{0}', e.message || e));
    }
  }

  // ------------------------------------------------------------------ preview playback (desktop)
  videoMedia() {
    return [...new Set(this.doc.screens.filter((s) => !s.info_mode && s.media).map((s) => this.doc.media.get(s.media)).filter((m) => m && m.kind === 'video' && m.el))];
  }
  async startPlay() {
    const vids = this.videoMedia();
    if (!vids.length) return;
    for (const m of vids) { m.el.currentTime = 0; }
    await Promise.all(vids.map((m) => m.el.play().catch(() => {})));
    vids.forEach((m) => { m.playing = true; });
    this.editor.playing = true;
    $('#btnPlay').classList.add('on');
    $('#btnPlay').textContent = t('⏸ עצור');
  }
  stopPlay() {
    for (const m of this.doc.media.values()) if (m.kind === 'video' && m.el) { m.el.pause(); m.playing = false; m.version++; }
    this.editor.playing = false;
    this.editor.invalidate();
    $('#btnPlay').classList.remove('on');
    $('#btnPlay').textContent = t('▶ נגן סרטונים בתצוגה');
  }

  // ------------------------------------------------------------------ export
  baseName() {
    const parts = [this.quote && this.quote.project, this.doc.projectName].filter(Boolean);
    return safeName(parts[0] || t('הדמיה')) || 'visualization';
  }

  async exportImageFlow() {
    if (!this.doc.bg) return;
    if (this.editor.playing) this.stopPlay();
    const p = progressBox(t('מייצא תמונה…'), false);
    p.set(0.3);
    let blob;
    try { blob = await exportImage(this.doc); } catch (e) { p.close(); return alertBox(t('ייצוא תמונה'), e.message); }
    p.close();
    await this.deliver(blob, `${this.baseName()}_${stamp()}.jpg`, t('התמונה מוכנה'));
  }

  async exportVideoFlow() {
    if (!this.doc.bg) return;
    if (!videoExportSupported()) return alertBox(t('ייצוא סרטון'), t('הדפדפן הזה לא תומך בייצוא וידאו. השתמש ב-Chrome או Edge במחשב.'));
    if (this.editor.playing) this.stopPlay();
    const vids = this.videoMedia();
    const longest = vids.reduce((a, m) => Math.max(a, m.duration || 0), 0);
    const prev = LS.get('viz.exportVideo', {});
    const num = (v, step, min) => h('input', { type: 'number', step: String(step), min: String(min), value: String(v), inputmode: 'decimal' });
    const dur = num(+(longest ? longest.toFixed(1) : (prev.duration || 10)), 1, 0.5);
    const fps = num(prev.fps || 30, 1, 1);
    const RES = [[t('Full HD (רוחב 1920)'), 1920], [t('4K (רוחב 3840)'), 3840], [t('HD (רוחב 1280)'), 1280], [t('מקורית (כמו התמונה)'), 0]];
    const res = h('select', {}, ...RES.map(([l, w]) => h('option', { value: w }, l)));
    res.value = String(prev.maxWidth ?? 1920);
    const audio = h('input', { type: 'checkbox' });
    audio.checked = vids.length > 0 && prev.audio !== false; audio.disabled = !vids.length;
    const ba = h('input', { type: 'checkbox' }); ba.checked = !!prev.beforeAfter;
    const hold = num(prev.hold ?? 1.5, 1, 0), wipe = num(prev.wipe ?? 2, 1, 0.2);
    const total = h('div', { class: 'info' });
    const field = (label, el, unit = '') => h('label', { class: 'field' }, h('span', {}, label), el, h('i', {}, unit));
    const baBox = h('div', {}, field(t('תמונה לפני (המתנה):'), hold, t('שניות')), field(t('משך השטיפה:'), wipe, t('שניות')), total);
    const upd = () => {
      baBox.hidden = !ba.checked;
      total.textContent = t('אורך הסרטון הכולל: {0} שניות ({1} לפני + {2} מתחילת השטיפה)', ((+hold.value || 0) + (+dur.value || 0)).toFixed(1), g(+hold.value || 0), g(+dur.value || 0));
    };
    const body = h('div', { style: 'display:flex;flex-direction:column;gap:8px' },
      field(t('משך:'), dur, t('שניות')), field(t('פריימים לשנייה:'), fps), field(t('רזולוציה:'), res),
      h('label', { class: 'check' }, audio, t('כלול שמע מהסרטון')),
      h('label', { class: 'check' }, ba, t('הנפשה לפני / אחרי (שטיפה משמאל לימין)')), baBox,
      h('p', { class: 'hint' }, t('סרטונים קצרים יותר מהמשך יתנגנו בלולאה.\nתמונה גדולה מהרזולוציה שנבחרה תוקטן.')));
    body.addEventListener('input', upd); body.addEventListener('change', upd); upd();
    const ok = await dialog({ title: t('ייצוא סרטון'), body, dismiss: false, buttons: [{ label: t('ביטול'), value: false }, { label: t('ייצא'), value: true, primary: true }] });
    if (!ok) return;
    const opts = {
      duration: Math.max(0.5, +dur.value || 10), fps: Math.max(1, Math.min(120, Math.round(+fps.value || 30))),
      maxWidth: +res.value || null, audio: audio.checked && !audio.disabled,
      beforeAfter: ba.checked ? { hold: Math.max(0, +hold.value || 0), wipe: Math.max(0.2, +wipe.value || 2) } : null,
    };
    LS.set('viz.exportVideo', { duration: opts.duration, fps: opts.fps, maxWidth: +res.value, audio: audio.disabled ? prev.audio : audio.checked, beforeAfter: ba.checked, hold: +hold.value, wipe: +wipe.value });
    const p = progressBox(t('מייצא סרטון…'));
    const t0 = performance.now();
    let result;
    try {
      result = await exportVideo(this.doc, opts, (f) => {
        const el = (performance.now() - t0) / 1000, left = f > 0.02 ? el / f - el : 0;
        p.set(f, t('{0}%  ·  נותרו כ-{1} שניות', Math.round(f * 100), Math.round(left)));
        return !p.cancelled;
      });
    } catch (e) {
      p.close();
      this.editor.invalidate();
      if (e.message === 'cancelled') return this.setStatus(t('הייצוא בוטל'));
      return alertBox(t('ייצוא סרטון'), e.message || String(e));
    }
    p.close();
    this.editor.invalidate();
    await this.deliver(result.blob, `${this.baseName()}_${stamp()}.mp4`, t('הסרטון מוכן ({0}×{1}{2})', result.width, result.height, result.audio ? t(', עם שמע') : ''));
  }

  /** Let the user keep a generated file: save to device / share / OneDrive. */
  /** Let the user keep a generated file. On a phone: the system share menu (Photos, WhatsApp, OneDrive, Files...). */
  async deliver(blob, filename, title) {
    const isProject = filename.toLowerCase().endsWith(PROJECT_EXT);
    let shareFile = null;
    if (MOBILE && navigator.canShare) {
      // phones don't know ".vizproj" - share projects as a standard .zip so OneDrive / Files accept them
      const cands = isProject
        ? [[filename.slice(0, -PROJECT_EXT.length) + '.zip', 'application/zip'], [filename.slice(0, -PROJECT_EXT.length) + '.zip', 'application/octet-stream']]
        : [[filename, blob.type || 'application/octet-stream']];
      for (const [nm, type] of cands) {
        const f = new File([blob], nm, { type });
        try { if (navigator.canShare({ files: [f] })) { shareFile = f; break; } } catch { /* next */ }
      }
    }
    const buttons = [];
    if (OD.configured()) buttons.push({ label: t('☁ שמור ב-OneDrive'), value: 'cloud' });
    buttons.push({ label: MOBILE ? t('הורד') : t('שמור במחשב…'), value: 'local', primary: !shareFile });
    if (shareFile) buttons.push({ label: isProject ? t('שמור ב-OneDrive / בקבצים') : t('תמונות · WhatsApp · OneDrive'), value: 'share', primary: true });
    const sizeMb = (blob.size / 1048576).toFixed(1);
    const hint = shareFile
      ? (isProject ? t('ייפתח תפריט השיתוף: בחר OneDrive, או "שמור בקבצים" ותיקייה ב-OneDrive.')
        : t('ייפתח תפריט השיתוף: "שמור תמונה" לתמונות, WhatsApp לשליחה, או OneDrive.'))
      : (MOBILE ? t('הקובץ יישמר בהורדות של הטלפון, ומשם אפשר להעלות אותו ל-OneDrive.') : null);
    const body = h('div', {}, h('div', {}, `${shareFile ? shareFile.name : filename}  (${sizeMb} MB)`), hint ? h('p', { class: 'hint' }, hint) : null);
    const choice = await dialog({ title, body, buttons, dismiss: null });
    if (choice === 'local') return saveLocal(blob, filename);
    if (choice === 'share') {
      try { await navigator.share({ files: [shareFile] }); return true; } catch (e) {
        if (e && e.name !== 'AbortError') alertBox(title, t('השיתוף נכשל: {0}', e.message || e.name));
        return false;
      }
    }
    if (choice === 'cloud') return !!(await this.uploadToCloud(blob, filename));
    return false;
  }

  // ------------------------------------------------------------------ projects
  async confirmDiscard() {
    if (!this.dirty || !this.doc.bg) return true;
    return confirmBox(t('שינויים שלא נשמרו'), t('יש שינויים שלא נשמרו. להמשיך בלי לשמור?'), t('המשך'), t('ביטול'));
  }

  async newProject() {
    if (!(await this.confirmDiscard())) return;
    if (this.editor.playing) this.stopPlay();
    this.doc.reset();
    this.doc.commit();
    this.savedPos = this.doc.hpos;
    this.selection.clear(); this.primary = null;
    this.quote = null;
    store.clearAutosave();
    this.goToStep(1);
  }

  async openProjectDialog() {
    if (!(await this.confirmDiscard())) return;
    // phones: no filter - iOS greys out file types it doesn't know (.vizproj)
    const f = await pickFile($('#fileProject'), MOBILE ? '' : `${PROJECT_EXT},.zip,.jpg,.jpeg,application/zip,application/octet-stream`);
    if (f) this.openProjectBlob(f, f.name);
  }

  async openProjectBlob(blob, name, fromAutosave = false) {
    if (this.editor.playing) this.stopPlay();
    const p = progressBox(t('פותח פרויקט…'), false);
    p.set(0.5);
    try {
      const r = await openProject(this.doc, blob, () => this.editor.invalidate());
      if (!this.doc.projectName && name) this.doc.projectName = safeName(name.replace(/\.[^.]+$/, ''));
      this.quote = r.quote && CAPS.quote ? parseRequest(r.quote) : null;
      this.doc.commit();
      this.savedPos = fromAutosave ? -1 : this.doc.hpos;
      this.selection.clear(); this.primary = null;
      p.close();
      this.editor.fitView();
      this.goToStep(this.doc.scale() ? 3 : this.doc.bg ? 2 : 1);
      if (r.skipped > 0) toast(t('{0} קבצי תוכן לא נפתחו במכשיר הזה', r.skipped));
      if (!CAPS.video && [...this.doc.media.values()].some((m) => m.dormant)) toast(t('הסרטונים בפרויקט נשמרים, אבל מוצגים רק בגרסת המחשב'));
    } catch (e) {
      p.close();
      alertBox(t('פתיחת פרויקט'), e.message || String(e));
    }
  }

  projectFilename() { return `${safeName(this.doc.projectName) || this.baseName()}${PROJECT_EXT}`; }

  async askProjectName() {
    if (this.doc.projectName) return true;
    const n = await promptText(t('שם הפרויקט'), t('שם לפרויקט:'), this.baseName());
    if (!n) return false;
    this.doc.projectName = safeName(n);
    return true;
  }

  async saveProjectLocal() {
    if (!this.doc.bg) return;
    if (!(await this.askProjectName())) return;
    const blob = await saveProject(this.doc, this.quote && this.quote.raw);
    if (MOBILE) { if (await this.saveProjectPhone(blob)) this.markSaved(); return; }
    if (await saveLocal(blob, this.projectFilename())) this.markSaved();
  }

  /** Phone: the project travels as a photo (JPG with the project inside) so OneDrive / WhatsApp show up,
   *  or as a .zip for "Save to Files". */
  async saveProjectPhone(zipBlob) {
    const base = safeName(this.doc.projectName) || this.baseName();
    const canFiles = (f) => { try { return !!(navigator.canShare && navigator.canShare({ files: [f] })); } catch { return false; } };
    const zipFile = new File([zipBlob], `${base}.zip`, { type: 'application/zip' });
    const imgFile = new File([await saveProjectImage(this.doc, this.quote && this.quote.raw)], `${base}.jpg`, { type: 'image/jpeg' });
    const buttons = [{ label: t('הורד'), value: 'local' }];
    if (canFiles(zipFile)) buttons.push({ label: t('קובץ ZIP (שמור בקבצים)'), value: 'zip' });
    if (canFiles(imgFile)) buttons.push({ label: t('OneDrive · WhatsApp (כתמונה)'), value: 'img', primary: true });
    else buttons[0].primary = true;
    const body = h('div', { style: 'display:flex;flex-direction:column;gap:8px' },
      h('div', {}, t('"כתמונה": נשמרת תמונת ההדמיה, והפרויקט המלא נמצא בתוכה. כדי להמשיך לעבוד פותחים אותה ב"פתח פרויקט" (בטלפון או במחשב).')),
      h('p', { class: 'hint' }, t('שמור ב-OneDrive ולא באפליקציית התמונות - התמונות עלולות לשמור רק את התמונה בלי הפרויקט.')));
    const choice = await dialog({ title: t('שמירת פרויקט'), body, buttons, dismiss: null });
    if (choice === 'local') return saveLocal(zipBlob, this.projectFilename());
    const f = choice === 'img' ? imgFile : choice === 'zip' ? zipFile : null;
    if (!f) return false;
    try { await navigator.share({ files: [f] }); return true; } catch (e) {
      if (e && e.name !== 'AbortError') alertBox(t('שמירת פרויקט'), t('השיתוף נכשל: {0}', e.message || e.name));
      return false;
    }
  }

  markSaved() { this.savedPos = this.doc.hpos; store.autosaveNow(this); this.updateUI(); this.setStatus(t('הפרויקט נשמר'), true); }

  // ------------------------------------------------------------------ OneDrive
  async ensureSignedIn() {
    if (!OD.configured()) { await alertBox('OneDrive', t('OneDrive עדיין לא הוגדר באפליקציה.\nיש לרשום את האפליקציה ב-Microsoft ולהכניס את ה-Client ID לקובץ config.js (ראה README-WEB.md).')); return false; }
    if (OD.isSignedIn()) return true;
    const ok = await confirmBox('OneDrive', t('יש להתחבר לחשבון Microsoft כדי לשמור ולפתוח קבצים ב-OneDrive.'), t('התחבר'), t('ביטול'));
    if (!ok) return false;
    if (this.doc.bg) { // a redirect sign-in reloads the page
      await store.autosaveNow(this);
      try { sessionStorage.setItem('viz.restore', '1'); } catch { /* ignore */ }
    }
    try { const acc = await OD.signIn(); try { sessionStorage.removeItem('viz.restore'); } catch { /* ignore */ } toast(t('מחובר ל-OneDrive: {0}', acc || '')); return true; } catch (e) { alertBox('OneDrive', e.message); return false; }
  }

  /** Folder / file browser. mode: 'save' -> {folderId, name}; 'open' -> File */
  async cloudBrowse({ mode, exts = [], name = '', title }) {
    if (!(await this.ensureSignedIn())) return null;
    let folder = LS.get('viz.od.folder', 'root');
    const list = h('div', { class: 'od-list' }), crumbs = h('div', { class: 'od-crumbs' });
    const nameInp = h('input', { type: 'text', value: name });
    let picked = null, resolveOpen;
    const load = async (id) => {
      list.replaceChildren(h('div', { class: 'od-item' }, t('טוען…')));
      try {
        const [items, path] = await Promise.all([OD.children(id), OD.pathOf(id)]);
        folder = id;
        crumbs.replaceChildren(...path.flatMap((p, i) => [i ? h('span', {}, '›') : null, h('button', { onclick: () => load(p.id) }, p.name)]));
        list.replaceChildren();
        const shown = items.filter((it) => it.folder || (mode === 'open' && exts.some((e) => it.name.toLowerCase().endsWith(e))));
        if (!shown.length) list.append(h('div', { class: 'od-item' }, h('small', {}, t('(תיקייה ריקה)'))));
        for (const it of shown) {
          const row = h('div', { class: 'od-item' }, h('span', { class: 'ic' }, it.folder ? '📁' : '📄'), h('span', { class: 'nm' }, it.name),
            h('small', {}, it.folder ? (it.folder.childCount ?? '') : `${(it.size / 1048576).toFixed(1)} MB`));
          row.addEventListener('click', () => {
            if (it.folder) return load(it.id);
            if (mode === 'open') { picked = it; resolveOpen && resolveOpen(); }
            else nameInp.value = it.name;
          });
          list.append(row);
        }
      } catch (e) { list.replaceChildren(h('div', { class: 'od-item' }, '⚠ ' + e.message)); }
    };
    const newFolder = async () => {
      const n = await promptText(t('תיקייה חדשה'), t('שם התיקייה:'), '');
      if (!n) return;
      try { const f = await OD.createFolder(folder, safeName(n)); await load(f.id); } catch (e) { alertBox('OneDrive', e.message); }
    };
    const body = h('div', { style: 'display:flex;flex-direction:column;gap:8px' }, crumbs, list,
      h('div', { class: 'row' }, h('button', { onclick: newFolder }, t('+ תיקייה חדשה')), h('small', { class: 'muted' }, OD.account() || '')),
      mode === 'save' ? h('label', { class: 'field' }, h('span', {}, t('שם הקובץ:')), nameInp) : null);
    load(folder);
    const dlgP = dialog({
      title: title || 'OneDrive', body, dismiss: null, cls: 'od',
      buttons: mode === 'save' ? [{ label: t('ביטול'), value: null }, { label: t('שמור כאן'), value: 'save', primary: true, validate: () => !!nameInp.value.trim() }]
        : [{ label: t('ביטול'), value: null }],
    });
    let result;
    if (mode === 'open') {
      result = await Promise.race([dlgP, new Promise((r) => { resolveOpen = () => r('picked'); })]);
      if (result === 'picked') document.querySelector('.modal-back:last-child')?.remove();
    } else result = await dlgP;
    if (!result) return null;
    LS.set('viz.od.folder', folder);
    if (mode === 'save') return { folderId: folder, name: safeName(nameInp.value) };
    const p = progressBox(t('מוריד מ-OneDrive…'), false);
    p.set(0.4, picked.name);
    try { return await OD.download(picked.id); } catch (e) { alertBox('OneDrive', e.message); return null; } finally { p.close(); }
  }

  async uploadToCloud(blob, filename, folderId = null) {
    let target = folderId ? { folderId, name: filename } : await this.cloudBrowse({ mode: 'save', name: filename, title: t('שמירה ב-OneDrive') });
    if (!target) return false;
    let name = target.name;
    const ext = filename.slice(filename.lastIndexOf('.'));
    if (!name.toLowerCase().endsWith(ext.toLowerCase())) name += ext;
    const p = progressBox(t('מעלה ל-OneDrive…'), false);
    try {
      await OD.upload(target.folderId, name, blob, (f) => p.set(f, name));
      p.close();
      toast(t('נשמר ב-OneDrive: {0}', name));
      return target;
    } catch (e) { p.close(); alertBox('OneDrive', e.message); return false; }
  }

  async saveProjectCloud() {
    if (!this.doc.bg) return;
    if (!(await this.ensureSignedIn())) return;
    if (!(await this.askProjectName())) return;
    const withImg = h('input', { type: 'checkbox' }); withImg.checked = LS.get('viz.od.withImg', true);
    const withPhoto = h('input', { type: 'checkbox' }); withPhoto.checked = LS.get('viz.od.withPhoto', false);
    const opts = await dialog({
      title: t('שמירה ב-OneDrive'), dismiss: null,
      body: h('div', { style: 'display:flex;flex-direction:column;gap:8px' },
        h('div', {}, t('הפרויקט יישמר כקובץ {0} שאפשר לפתוח גם במחשב.', this.projectFilename())),
        h('label', { class: 'check' }, withImg, t('שמור גם תמונת הדמיה (JPG) באותה תיקייה')),
        h('label', { class: 'check' }, withPhoto, t('שמור גם את התמונה המקורית מהשטח'))),
      buttons: [{ label: t('ביטול'), value: null }, { label: t('בחר תיקייה…'), value: 'go', primary: true }],
    });
    if (!opts) return;
    LS.set('viz.od.withImg', withImg.checked); LS.set('viz.od.withPhoto', withPhoto.checked);
    const target = await this.cloudBrowse({ mode: 'save', name: this.projectFilename(), title: t('שמירת פרויקט ב-OneDrive') });
    if (!target) return;
    const base = target.name.replace(/\.vizproj$/i, '');
    const p = progressBox(t('שומר ב-OneDrive…'), false);
    try {
      p.set(0.05, t('מכין את הפרויקט…'));
      const blob = await saveProject(this.doc, this.quote && this.quote.raw);
      const jobs = [[`${base}${PROJECT_EXT}`, blob]];
      if (withImg.checked) jobs.push([`${base}.jpg`, await exportImage(this.doc)]);
      const orig = this.doc.bg.blob || [...this.doc.bgPool.values()].find((b) => b.blob)?.blob;
      if (withPhoto.checked && orig) jobs.push([`${base}_photo.${(orig.type || '').includes('png') ? 'png' : 'jpg'}`, orig]);
      for (let i = 0; i < jobs.length; i++) {
        const [nm, b] = jobs[i];
        await OD.upload(target.folderId, nm, b, (f) => p.set((i + f) / jobs.length, nm));
      }
      p.close();
      this.doc.projectName = base;
      this.markSaved();
      toast(t('נשמר ב-OneDrive: {0}', jobs.map((j) => j[0]).join(', ')), 5000);
    } catch (e) { p.close(); alertBox('OneDrive', e.message); }
  }

  async openProjectCloud() {
    if (!(await this.confirmDiscard())) return;
    const f = await this.cloudBrowse({ mode: 'open', exts: [PROJECT_EXT], title: t('פתיחת פרויקט מ-OneDrive') });
    if (f) this.openProjectBlob(f, f.name);
  }

  async loadBgFromCloud() {
    const f = await this.cloudBrowse({ mode: 'open', exts: ['.jpg', '.jpeg', '.png', '.webp', '.heic'], title: t('תמונה מ-OneDrive') });
    if (f) this.setBackground(f);
  }

  async loadContentFromCloud(s) {
    const exts = ['.jpg', '.jpeg', '.png', '.webp'].concat(CAPS.video ? ['.mp4', '.mov', '.webm', '.m4v'] : []);
    const f = await this.cloudBrowse({ mode: 'open', exts, title: t('תוכן מ-OneDrive') });
    if (f) this.setContent(s, f);
  }

  async cloudMenu() {
    const signed = OD.isSignedIn();
    const c = await dialog({
      title: 'OneDrive', dismiss: null, cls: 'menu-sheet',
      body: h('div', { style: 'display:flex;flex-direction:column;gap:8px' },
        h('div', { class: 'info' }, signed ? t('מחובר: {0}', OD.account() || '') : t('לא מחובר')),
        ...[['open', t('📂 פתח פרויקט מ-OneDrive…')], ['save', t('💾 שמור פרויקט ב-OneDrive…')], ['photo', t('🖼 טען תמונה מהשטח מ-OneDrive…')]]
          .map(([v, l]) => h('button', { class: 'wide', onclick: (e) => { e.target.closest('.modal-back').remove(); this['_cloud_' + v](); } }, l))),
      buttons: [signed ? { label: t('התנתק'), value: 'out', danger: true } : { label: t('התחבר'), value: 'in' }, { label: t('סגור'), value: null }],
    });
    if (c === 'out') { OD.signOut(); toast(t('התנתקת מ-OneDrive')); }
    if (c === 'in') this.ensureSignedIn();
  }
  _cloud_open() { this.openProjectCloud(); }
  _cloud_save() { this.saveProjectCloud(); }
  _cloud_photo() { this.loadBgFromCloud(); }

  // ------------------------------------------------------------------ quote (desktop)
  async openQuoteFile(file = null) {
    const f = file || await pickFile($('#fileQuote'), '.json,application/json');
    if (!f) return;
    try { this.loadQuote(parseRequest(JSON.parse(await f.text()))); } catch (e) { alertBox(t('בקשת הדמיה מההצעה'), e.message); }
  }

  async loadQuote(req) {
    this.quote = req;
    this.quoteSel = 0;
    if (req.background && /^https?:/i.test(req.background)) {
      try { const r = await fetch(req.background); if (r.ok) await this.setBackground(new File([await r.blob()], 'site.jpg', { type: 'image/jpeg' })); } catch { /* optional */ }
    }
    if (!this.doc.projectName && req.project) this.doc.projectName = safeName(req.project);
    const n = req.screens.reduce((a, q) => a + q.qty, 0);
    this.setStatus(t('נפתח מההצעה{0}: {1} מסכים ימתינו בשלב 3.', quoteTitle(req) ? ' ' + quoteTitle(req) : '', n));
    this.updateUI();
  }

  renderQuote() {
    const box = $('#quoteBox');
    box.hidden = !(this.quote && this.quote.screens.length);
    if (box.hidden) return;
    $('#quoteTitle').textContent = quoteTitle(this.quote);
    const list = $('#quoteList');
    list.replaceChildren();
    this.quote.screens.forEach((q, i) => {
      q.added = this.doc.screens.filter((s) => s.quote_idx === i).length;
      list.append(h('div', { class: 'item' + (i === this.quoteSel ? ' sel' : ''), onclick: () => { this.quoteSel = i; this.renderQuote(); } },
        h('span', {}, (q.added >= q.qty ? '✔ ' : '') + quoteLabel(q)), h('small', {}, `${q.added}/${q.qty}`)));
    });
    $('#btnQuoteAdd').disabled = $('#btnQuoteAll').disabled = !this.doc.scale();
  }

  addQuoteScreens(selectedOnly) {
    const sc = this.doc.scale();
    if (!this.quote || !sc || this.step !== 3) return;
    const qs = this.quote.screens;
    const todo = selectedOnly ? (qs[this.quoteSel] ? [this.quoteSel] : []) : qs.flatMap((q, i) => Array(Math.max(0, q.qty - q.added)).fill(i));
    if (!todo.length) return this.setStatus(t('כל המסכים מההצעה כבר נוספו'), true);
    const c = this.editor.viewCenterImg(), off = 30 / this.editor.view.zoom;
    let last = null;
    todo.forEach((qi, i) => {
      const q = qs[qi];
      const s = new Screen(q.qty === 1 ? q.name : `${q.name} ${q.added + 1}`, q.width_cm, q.height_cm, 0);
      s.custom = true; s.pitch = q.pitch || s.pitch; s.model = q.model; s.setQuoteRes(q.res); s.quote_idx = qi; s.info_mode = true;
      s.setRect({ x: c.x + off * i, y: c.y + off * i }, s.total_w * sc[0], s.total_h * sc[1]);
      q.added++;
      this.doc.screens.push(s);
      last = s;
    });
    this.select(last);
    this.commit();
    this.setStatus(t('נוספו {0} מסכים מההצעה. גרור כל מסך למקומו.', todo.length), true);
  }

  // ------------------------------------------------------------------ settings & menus
  async settingsDialog() {
    const lang = h('select', {}, h('option', { value: 'he' }, 'עברית'), h('option', { value: 'en' }, 'English'));
    lang.value = LANG;
    const dev = h('select', {},
      h('option', { value: 'auto' }, t('אוטומטי (זוהה: {0})', detectMobile() ? t('טלפון / טאבלט') : t('מחשב'))),
      h('option', { value: 'desktop' }, t('מחשב - כל היכולות')),
      h('option', { value: 'mobile' }, t('טלפון / טאבלט')));
    dev.value = deviceSetting();
    const field = (label, el) => h('label', { class: 'field' }, h('span', {}, label), el, h('i'));
    const od = OD.configured()
      ? h('div', { class: 'row' }, h('span', { class: 'info', style: 'flex:1' }, OD.isSignedIn() ? t('OneDrive: מחובר ({0})', OD.account() || '') : t('OneDrive: לא מחובר')),
        OD.isSignedIn() ? h('button', { onclick: (e) => { OD.signOut(); e.target.closest('.modal-back').remove(); toast(t('התנתקת מ-OneDrive')); } }, t('התנתק'))
          : h('button', { onclick: (e) => { e.target.closest('.modal-back').remove(); this.ensureSignedIn(); } }, t('התחבר')))
      : h('div', { class: 'hint' }, t('OneDrive: לא הוגדר (ראה README-WEB.md)'));
    const ok = await dialog({
      title: t('הגדרות'), dismiss: false,
      body: h('div', { style: 'display:flex;flex-direction:column;gap:10px' }, field(t('שפה:'), lang), field(t('תצוגה:'), dev), od,
        h('div', { class: 'hint' }, t('גרסת המחשב: כל היכולות כולל סרטונים וחיבור להצעת מחיר. גרסת הטלפון: תמונות, מותאמת למגע.'))),
      buttons: [{ label: t('ביטול'), value: false }, { label: t('שמור'), value: true, primary: true }],
    });
    if (!ok || (lang.value === LANG && dev.value === deviceSetting())) return;
    setLanguage(lang.value);
    setDeviceSetting(dev.value);
    if (this.doc.bg) {
      await store.autosaveNow(this);
      try { sessionStorage.setItem('viz.restore', '1'); } catch { /* ignore */ }
    }
    location.reload();
  }

  async mobileMenu() {
    const item = (label, fn, show = true) => (show ? h('button', { class: 'wide', onclick: (e) => { e.target.closest('.modal-back').remove(); fn(); } }, label) : null);
    await dialog({
      title: t('תפריט'), dismiss: null, cls: 'menu-sheet',
      body: h('div', { style: 'display:flex;flex-direction:column;gap:8px' },
        item(t('🆕 פרויקט חדש'), () => this.newProject()),
        item(t('📂 פתח פרויקט מהמכשיר…'), () => this.openProjectDialog()),
        item(t('💾 שמור פרויקט במכשיר…'), () => this.saveProjectLocal(), !!this.doc.bg),
        item(t('☁ פתח פרויקט מ-OneDrive…'), () => this.openProjectCloud(), OD.configured()),
        item(t('☁ שמור פרויקט ב-OneDrive…'), () => this.saveProjectCloud(), OD.configured() && !!this.doc.bg),
        item(t('⚙ הגדרות'), () => this.settingsDialog())),
      buttons: [{ label: t('סגור'), value: null }],
    });
  }

  async mobileExportMenu() {
    const item = (label, fn, show = true) => (show ? h('button', { class: 'wide primary', onclick: (e) => { e.target.closest('.modal-back').remove(); fn(); } }, label) : null);
    await dialog({
      title: t('ייצוא ושמירה'), dismiss: null, cls: 'menu-sheet',
      body: h('div', { style: 'display:flex;flex-direction:column;gap:8px' },
        item(t('🖼 ייצא תמונת הדמיה'), () => this.exportImageFlow()),
        item(t('🎬 ייצא סרטון'), () => this.exportVideoFlow(), CAPS.video),
        item(t('☁ שמור פרויקט ב-OneDrive'), () => this.saveProjectCloud(), OD.configured()),
        item(t('💾 שמור פרויקט במכשיר'), () => this.saveProjectLocal())),
      buttons: [{ label: t('סגור'), value: null }],
    });
  }
}

/** Save a blob to the user's device. Returns true when saved (or download started). */
export async function saveLocal(blob, filename) {
  if (window.showSaveFilePicker && !MOBILE) {
    const ext = filename.slice(filename.lastIndexOf('.'));
    try {
      const hnd = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: ext, accept: { [blob.type || 'application/octet-stream']: [ext] } }] });
      const w = await hnd.createWritable();
      await w.write(blob); await w.close();
      return true;
    } catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return true;
}

window.app = new App();

// offline cache (hosted version only; a local file works offline anyway)
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
}
