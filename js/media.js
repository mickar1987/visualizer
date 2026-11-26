// Loading photos / content images / videos into the document.
import { newId } from './model.js';
import { CAPS } from './device.js';

export const isVideoFile = (f) => /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name || '');
export const isImageFile = (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i.test(f.name || '');

/** Decode an image blob (EXIF orientation applied) and shrink it so the long side <= maxSide. */
export async function decodeImage(blob, maxSide) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    // Fallback through <img> (e.g. formats createImageBitmap doesn't take)
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      bmp = await createImageBitmap(img);
    } finally { URL.revokeObjectURL(url); }
  }
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  if (s < 1) {
    const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
    const small = await createImageBitmap(bmp, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
    bmp.close();
    bmp = small;
  }
  return bmp;
}

export async function addBackground(doc, blob, name, maxSide = null) {
  const bmp = await decodeImage(blob, Math.min(maxSide || CAPS.maxImage, 16384));
  const id = newId('bg');
  doc.bgPool.set(id, { id, src: bmp, w: bmp.width, h: bmp.height, name: name || 'photo', blob, mime: blob.type });
  return id;
}

export async function addMedia(doc, blob, name, onFrame) {
  const id = newId('m');
  if (isVideoFile(blob) || (name && isVideoFile({ name, type: blob.type }))) {
    const el = document.createElement('video');
    el.muted = true; el.loop = true; el.playsInline = true; el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    const url = URL.createObjectURL(blob);
    el.src = url;
    await new Promise((res, rej) => {
      el.addEventListener('loadeddata', res, { once: true });
      el.addEventListener('error', () => rej(new Error('video')), { once: true });
    });
    const m = { id, kind: 'video', name, blob, mime: blob.type || 'video/mp4', el, url, w: el.videoWidth, h: el.videoHeight, duration: el.duration || 0, version: 1, playing: false };
    el.addEventListener('seeked', () => { m.version++; onFrame && onFrame(); });
    // make sure the first frame is decoded (some browsers show nothing until a seek)
    try { el.currentTime = 0.001; } catch { /* ignore */ }
    doc.media.set(id, m);
    return m;
  }
  const bmp = await decodeImage(blob, CAPS.mobile ? 2048 : 4096);
  const m = { id, kind: 'image', name, blob, mime: blob.type || 'image/jpeg', el: bmp, w: bmp.width, h: bmp.height, version: 1 };
  doc.media.set(id, m);
  return m;
}

export function disposeMedia(m) {
  if (m.kind === 'video') { m.el.pause(); m.el.removeAttribute('src'); m.el.load(); URL.revokeObjectURL(m.url); }
  else if (m.el && m.el.close) m.el.close();
}
