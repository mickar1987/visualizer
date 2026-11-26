// Project file (.vizproj = zip): project.json + background photo + content media.
import { Screen } from './model.js';
import { addBackground, addMedia } from './media.js';
import { t } from './i18n.js';
import { CAPS } from './device.js';

export const PROJECT_EXT = '.vizproj';
const extOf = (mime, fallback) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' }[mime] || fallback);

async function bgBlob(bg) {
  // the working image (already rotated / shrunk), so coordinates match exactly
  const cv = document.createElement('canvas');
  cv.width = bg.w; cv.height = bg.h;
  cv.getContext('2d').drawImage(bg.src, 0, 0);
  return new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.93));
}

export async function saveProject(doc, quote) {
  const zip = new JSZip();
  const bg = doc.bg;
  const used = [...new Set(doc.screens.map((s) => s.media).filter(Boolean))];
  const media = [];
  for (const id of used) {
    const m = doc.media.get(id);
    if (!m) continue;
    const file = `media/${id}.${extOf(m.mime, m.kind === 'video' ? 'mp4' : 'jpg')}`;
    zip.file(file, m.blob);
    media.push({ id, file, kind: m.kind, name: m.name, mime: m.mime });
  }
  if (bg) zip.file('background.jpg', await bgBlob(bg));
  const proj = {
    app: 'ctv-visualizer-web', version: 1, saved: new Date().toISOString(), name: doc.projectName || '',
    background: bg ? { file: 'background.jpg', name: bg.name, w: bg.w, h: bg.h, valid: bg.valid || null } : null,
    measures: doc.measures, screens: doc.screens.map((s) => s.toDict()), media, quote: quote || null,
  };
  zip.file('project.json', JSON.stringify(proj, null, 1));
  return zip.generateAsync({ type: 'blob', mimeType: 'application/zip', compression: 'STORE' });
}

/** Loads into a fresh doc state. Returns {quote}. */
export async function openProject(doc, blob, onFrame) {
  let zip, proj;
  try {
    zip = await JSZip.loadAsync(blob);
    proj = JSON.parse(await zip.file('project.json').async('string'));
  } catch {
    throw new Error(t('הקובץ אינו פרויקט הדמיה תקין'));
  }
  if (proj.app !== 'ctv-visualizer-web') throw new Error(t('הקובץ אינו פרויקט הדמיה תקין'));
  doc.reset();
  doc.projectName = proj.name || '';
  let k = 1;
  if (proj.background) {
    const b = await zip.file(proj.background.file).async('blob');
    const id = await addBackground(doc, new Blob([b], { type: 'image/jpeg' }), proj.background.name);
    doc.bgId = id;
    k = doc.bg.w / proj.background.w; // a phone may keep a smaller copy of a large photo
    if (proj.background.valid) doc.bg.valid = proj.background.valid.map((p) => ({ x: p.x * k, y: p.y * k }));
  }
  const idMap = {};
  for (const m of proj.media || []) {
    const f = zip.file(m.file);
    if (!f) continue;
    const b = new Blob([await f.async('blob')], { type: m.mime });
    if (m.kind === 'video' && !CAPS.video) {
      // mobile mode: keep the video in the project (so it survives a save) without playing it
      doc.media.set(m.id, { id: m.id, kind: 'video', name: m.name, blob: b, mime: m.mime, el: null, dormant: true, version: 0 });
      idMap[m.id] = m.id;
      continue;
    }
    try {
      const mm = await addMedia(doc, b, m.name, onFrame);
      idMap[m.id] = mm.id;
    } catch { /* unsupported here (e.g. video on a phone) - the screen keeps no content */ }
  }
  const sc = (p) => ({ x: p.x * k, y: p.y * k });
  const measures = {};
  for (const [kk, m] of Object.entries(proj.measures || {})) measures[kk] = { p1: sc(m.p1), p2: sc(m.p2), cm: m.cm };
  doc.measures = measures;
  doc.screens = (proj.screens || []).map((d) => {
    const s = Screen.fromDict(d);
    s.corners = s.corners.map(sc);
    s.media = d.media && idMap[d.media] ? idMap[d.media] : null;
    if (d.media && !s.media) s.info_mode = true;
    return s;
  });
  return { quote: proj.quote || null, skipped: (proj.media || []).length - Object.keys(idMap).length };
}
