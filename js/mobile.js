// Phone / tablet interface: step bar on top, one instruction line, and a bottom action bar whose buttons
// follow the current step and selection. Settings open in a bottom sheet with a title and a close button.
import { t } from './i18n.js';
import { icon } from './icons.js';
import { $, h } from './ui.js';

export class MobileUI {
  constructor(app) {
    this.app = app;
    this.steps = h('nav', { id: 'mSteps' });
    [[1, 'תמונה'], [2, 'קנה מידה'], [3, 'מסכים']].forEach(([n, label]) => {
      this.steps.append(h('button', { class: 'mstep', 'data-step': n, onclick: () => app.goToStep(n) }, h('b', {}, String(n)), h('span', {}, t(label))));
    });
    this.hint = h('div', { id: 'mHint' });
    this.bar = h('nav', { id: 'mBar' });
    this.sheetTitle = h('div', { class: 'title' });
    this.sheetBody = h('div', { class: 'sbody' });
    this.sheet = h('section', { id: 'mSheet', hidden: true },
      h('header', {}, this.sheetTitle, h('button', { class: 'iconbtn', 'aria-label': t('סגור'), onclick: () => this.closeSheet() })),
      this.sheetBody);
    this.sheet.querySelector('.iconbtn').innerHTML = icon('close');
    document.getElementById('topbar').after(this.steps, this.hint);
    document.body.append(this.sheet, this.bar);

    // move the panels the phone needs into sheet sections (event handlers stay attached)
    this.sections = {
      tools: { title: t('יישור וחיתוך'), el: $('#toolsBox') },
      scale: { title: t('קנה מידה'), el: h('div', { class: 'col' }, $('#measureList'), $('#lblScale')) },
      props: { title: t('מסך נבחר'), el: h('div', { class: 'col' }, h('div', { class: 'row wrap' }, $('#btnLink'), $('#btnMagnet')), $('#props')) },
      anno: { title: t('חץ / טקסט'), el: $('#annoProps') },
    };
    for (const s of Object.values(this.sections)) { s.el.hidden = true; this.sheetBody.append(s.el); }
    this.mode = null;
  }

  openSheet(mode) {
    if (this.mode === mode) return this.closeSheet();
    this.mode = mode;
    for (const [k, s] of Object.entries(this.sections)) s.el.hidden = k !== mode;
    this.sheetTitle.textContent = this.sections[mode].title;
    this.sheet.hidden = false;
    this.refresh();
    requestAnimationFrame(() => this.keepSelectionVisible());
  }

  /** Scroll the view so the selected screen is not hidden behind the open sheet. */
  keepSelectionVisible() {
    const s = this.app.current, ed = this.app.editor;
    if (!s || this.sheet.hidden) return;
    const stage = document.getElementById('stage').getBoundingClientRect();
    const visBottom = this.sheet.getBoundingClientRect().top - stage.top - 12;
    const pts = s.corners.map((p) => ed.toView(p));
    const top = Math.min(...pts.map((p) => p.y)), bottom = Math.max(...pts.map((p) => p.y));
    if (bottom <= visBottom && top >= 8) return;
    const target = Math.max(8 + (bottom - top) / 2, visBottom / 2);
    ed.view.y += target - (top + bottom) / 2;
    ed.invalidate();
  }

  closeSheet() {
    this.mode = null;
    this.sheet.hidden = true;
    this.refresh();
  }

  btn(ic, label, fn, { primary = false, disabled = false, on = false } = {}) {
    const b = h('button', { class: 'mbtn' + (primary ? ' primary' : '') + (on ? ' on' : '') });
    b.disabled = disabled;
    // Act when the finger lifts: on iPhone the first tap on a button that just appeared can be
    // swallowed as a "hover", so waiting for "click" made people tap twice.
    let down = false, fired = 0;
    b.addEventListener('pointerdown', (e) => { down = e.pointerType !== 'mouse'; });
    b.addEventListener('pointerleave', () => { down = false; });
    b.addEventListener('pointerup', (e) => {
      if (!down || b.disabled) return;
      down = false; fired = Date.now();
      e.preventDefault();
      fn();
    });
    b.addEventListener('click', () => { if (Date.now() - fired > 800 && !b.disabled) fn(); });
    b.innerHTML = icon(ic, 24) + `<span>${label}</span>`;
    if (ic === 'next') b.firstChild.classList.add('flip-ltr');
    return b;
  }

  refresh() {
    const app = this.app, doc = app.doc, step = app.step, bg = doc.bg, sc = doc.scale();
    const tool = app.editor.tool, sel = app.current;
    this.steps.querySelectorAll('.mstep').forEach((b) => {
      const n = +b.dataset.step;
      b.classList.toggle('active', n === step);
      b.classList.toggle('done', n < step);
      b.disabled = (n >= 2 && !bg) || (n === 3 && !sc);
    });
    if (step !== 1 && this.mode === 'tools') this.closeSheet();
    if (step !== 2 && this.mode === 'scale') this.closeSheet();
    if ((step !== 3 || !sel) && this.mode === 'props') this.closeSheet();
    const anno = app.currentAnno;
    if ((step !== 3 || !anno) && this.mode === 'anno') this.closeSheet();

    // instruction line
    let hint;
    if (tool) hint = $('#toolHint').textContent;
    else if (step === 1) hint = bg ? t('יישר או חתוך אם צריך, ואז "הבא"') : t('צלם או בחר תמונה של המקום');
    else if (step === 2) hint = sc ? t('קנה המידה מוכן. אפשר לדייק את הקצוות, ואז "הבא"') : t('סמן קו על דבר שמידתו ידועה (דלת, חלון)');
    else if (!doc.screens.length) hint = t('הוסף מסך');
    else if (anno) hint = anno.type === 'arrow' ? t('גרור להזזה · קצוות החץ לשינוי') : t('גרור להזזה');
    else if (!sel) hint = t('הקש על מסך כדי לבחור אותו');
    else hint = t('גרור להזזה · פינות = פרספקטיבה · ידית ירוקה = סיבוב');
    this.hint.textContent = hint;
    this.hint.classList.toggle('tool', !!tool);

    // action bar
    const B = [];
    if (app.editor.pending) {
      B.push(this.btn('close', t('ביטול'), () => app.cancelPending()));
      B.push(this.btn('check', t('אישור'), () => app.confirmPending(), { primary: true }));
    } else if (tool) {
      B.push(this.btn('close', t('ביטול'), () => app.setTool(null)));
    } else if (step === 1) {
      if (!bg) {
        B.push(this.btn('camera', t('צלם'), () => app.loadBgDialog(true), { primary: true }));
        B.push(this.btn('image', t('גלריה'), () => app.loadBgDialog()));
        B.push(this.btn('folder', t('פרויקט'), () => app.openProjectDialog()));
      } else {
        B.push(this.btn('image', t('החלף'), () => app.loadBgDialog()));
        B.push(this.btn('level', t('יישור וחיתוך'), () => this.openSheet('tools'), { on: this.mode === 'tools' }));
        B.push(this.btn('next', t('הבא'), () => app.goToStep(2), { primary: true }));
      }
    } else if (step === 2) {
      B.push(this.btn('ruler_h', t('רוחב ידוע'), () => app.setTool('w')));
      B.push(this.btn('ruler_v', t('גובה ידוע'), () => app.setTool('h')));
      if (Object.keys(doc.measures).length) B.push(this.btn('sliders', t('ערכים'), () => this.openSheet('scale'), { on: this.mode === 'scale' }));
      B.push(this.btn('next', t('הבא'), () => app.goToStep(3), { primary: true, disabled: !sc }));
    } else if (step === 3 && anno) {
      B.push(this.btn('sliders', t('הגדרות'), () => this.openSheet('anno'), { on: this.mode === 'anno' }));
      B.push(this.btn('trash', t('מחק'), () => app.deleteAnno()));
      B.push(this.btn('check', t('סיום'), () => app.selectAnno(null), { primary: true }));
    } else if (sel) {
      B.push(this.btn('image', t('תוכן'), () => app.loadContentFor(sel)));
      B.push(this.btn('sliders', t('הגדרות'), () => this.openSheet('props'), { on: this.mode === 'props' }));
      B.push(this.btn('copy', t('שכפל'), () => app.duplicateScreen()));
      B.push(this.btn('trash', t('מחק'), () => app.deleteScreens()));
      B.push(this.btn('check', t('סיום'), () => { app.selection.clear(); app.onSelectionChanged(); }, { primary: true }));
    } else {
      B.push(this.btn('plus', t('מסך'), () => app.addScreenDialog(), { primary: true }));
      B.push(this.btn('arrow', t('חץ'), () => app.setTool('arrow'), { disabled: !doc.bg }));
      B.push(this.btn('text', t('טקסט'), () => app.setTool('text'), { disabled: !doc.bg }));
      B.push(this.btn('share', t('ייצוא'), () => app.exportImageFlow(), { disabled: !doc.screens.length }));
      B.push(this.btn('save', t('שמור'), () => app.saveProjectLocal()));
    }
    this.bar.replaceChildren(...B);
  }
}
