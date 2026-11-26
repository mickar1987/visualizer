// Export: full-resolution image, and MP4 video (WebCodecs H.264 + mp4-muxer) with optional before/after wipe.
import { Renderer } from './renderer.js';
import { buildScene } from './editor.js';
import { t } from './i18n.js';

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error(t('לא ניתן לטעון רכיב ייצוא מהאינטרנט')));
    document.head.append(s);
  });
}

function canvasToBlob(cv, type, q) {
  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), type, q));
}

/** Render the scene into a new canvas of w x h (image pixels scaled by w / bg.w). */
function renderComposite(doc, w, h, opts = {}) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const r = new Renderer(cv, { preserve: true });
  const draw = (o = {}) => r.draw(buildScene(doc, { ...opts, ...o }), { zoom: w / doc.bg.w, x: 0, y: 0 });
  return { cv, r, draw };
}

export async function exportImage(doc, { type = 'image/jpeg', quality = 0.92 } = {}) {
  const bg = doc.bg;
  const { cv, r, draw } = renderComposite(doc, bg.w, bg.h);
  draw();
  const blob = await canvasToBlob(cv, type, quality);
  r.destroy();
  return blob;
}

const ease = (p) => { p = Math.min(1, Math.max(0, p)); return p * p * (3 - 2 * p); };

function seek(video, time) {
  return new Promise((res) => {
    if (Math.abs(video.currentTime - time) < 1e-4 && video.readyState >= 2) return res();
    const done = () => { video.removeEventListener('seeked', done); res(); };
    video.addEventListener('seeked', done);
    video.currentTime = time;
  });
}

async function pickVideoCodec(w, h, fps) {
  const bitrate = Math.round(Math.min(60e6, Math.max(4e6, w * h * fps * 0.12)));
  for (const codec of ['avc1.640033', 'avc1.640034', 'avc1.4d0033', 'avc1.42003e', 'avc1.42001f']) {
    const cfg = { codec, width: w, height: h, bitrate, framerate: fps, avc: { format: 'avc' } };
    try { const s = await VideoEncoder.isConfigSupported(cfg); if (s.supported) return cfg; } catch { /* try next */ }
  }
  return null;
}

/** Decode the soundtrack of a video blob (null when there is none or it can't be decoded). */
async function decodeAudio(blob) {
  try {
    const ac = new OfflineAudioContext(2, 48000, 48000);
    return await ac.decodeAudioData(await blob.arrayBuffer());
  } catch { return null; }
}

async function pickAudioCodec(sampleRate, channels) {
  for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const cfg = { codec, sampleRate, numberOfChannels: channels, bitrate: 192000 };
    try { const s = await AudioEncoder.isConfigSupported(cfg); if (s.supported) return { cfg, mux }; } catch { /* next */ }
  }
  return null;
}

export const videoExportSupported = () => typeof VideoEncoder !== 'undefined';

/**
 * opts: {duration, fps, maxWidth|null, audio(bool), beforeAfter: null | {hold, wipe}}
 * progress(fraction) -> false to cancel. Returns {blob, width, height, audio}
 */
export async function exportVideo(doc, opts, progress) {
  if (!videoExportSupported()) throw new Error(t('הדפדפן הזה לא תומך בייצוא וידאו. השתמש ב-Chrome או Edge במחשב.'));
  if (!window.Mp4Muxer) await loadScript('vendor/mp4-muxer.min.js');
  const bg = doc.bg;
  const { duration, fps } = opts;
  const hold = opts.beforeAfter ? Math.max(0, opts.beforeAfter.hold) : 0;
  const wipe = opts.beforeAfter ? Math.max(0.1, opts.beforeAfter.wipe) : 0;
  const scale = opts.maxWidth ? Math.min(1, opts.maxWidth / bg.w) : 1;
  const W = Math.max(2, Math.floor((bg.w * scale) / 2) * 2), H = Math.max(2, Math.floor((bg.h * scale) / 2) * 2);
  const vcfg = await pickVideoCodec(W, H, fps);
  if (!vcfg) throw new Error(t('הדפדפן לא מצליח לקודד וידאו ברזולוציה {0}×{1}. נסה רזולוציה נמוכה יותר.', W, H));

  // videos used on screens, and the soundtrack (first video that has one)
  const vids = [...new Set(doc.screens.filter((s) => !s.info_mode && s.media).map((s) => doc.media.get(s.media)).filter((m) => m && m.kind === 'video'))];
  let audio = null;
  if (opts.audio) for (const m of vids) { const buf = await decodeAudio(m.blob); if (buf) { audio = buf; break; } }
  const acodec = audio ? await pickAudioCodec(audio.sampleRate, Math.min(2, audio.numberOfChannels)) : null;
  if (!acodec) audio = null;

  const { Muxer, ArrayBufferTarget } = window.Mp4Muxer;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target, fastStart: 'in-memory', firstTimestampBehavior: 'offset',
    video: { codec: 'avc', width: W, height: H, frameRate: fps },
    audio: audio ? { codec: acodec.mux, numberOfChannels: acodec.cfg.numberOfChannels, sampleRate: acodec.cfg.sampleRate } : undefined,
  });
  let encErr = null;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => { encErr = e; } });
  venc.configure(vcfg);

  const { cv: glc, r, draw } = renderComposite(doc, W, H);
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const oc = out.getContext('2d');
  // the photo without screens ("before")
  const before = document.createElement('canvas');
  before.width = W; before.height = H;
  before.getContext('2d').drawImage(bg.src, 0, 0, W, H);
  for (const m of vids) { m.el.pause(); m.playing = false; }
  const saved = vids.map((m) => m.el.currentTime);

  const total = hold + duration;
  const n = Math.max(1, Math.round(total * fps));
  try {
    for (let i = 0; i < n; i++) {
      if (encErr) throw encErr;
      const tt = i / fps, tv = Math.max(0, tt - hold);
      if (opts.beforeAfter && tt < hold) {
        oc.drawImage(before, 0, 0);
      } else {
        await Promise.all(vids.map((m) => seek(m.el, m.duration > 0 ? (tv % m.duration) : 0)));
        draw({ frameTick: i });
        for (const m of vids) m.version++;
        oc.drawImage(glc, 0, 0);
        if (opts.beforeAfter) {
          const p = ease(tv / wipe);
          if (p < 1) wipeOver(oc, before, glc, p, W, H);
        }
      }
      const frame = new VideoFrame(out, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      venc.encode(frame, { keyFrame: i % Math.round(fps * 2) === 0 });
      frame.close();
      while (venc.encodeQueueSize > 4) await new Promise((res) => setTimeout(res, 1));
      if (progress && progress((i + 1) / n) === false) throw new Error('cancelled');
    }
    await venc.flush();
    if (audio) await encodeAudio(muxer, audio, acodec.cfg, hold, duration);
    muxer.finalize();
  } finally {
    try { venc.close(); } catch { /* closed */ }
    r.destroy();
    vids.forEach((m, k) => { try { m.el.currentTime = saved[k]; } catch { /* ignore */ } });
  }
  return { blob: new Blob([target.buffer], { type: 'video/mp4' }), width: W, height: H, audio: !!audio };
}

function wipeOver(oc, before, after, p, W, H) {
  // `after` is revealed from the left up to p*W with a soft edge and a thin white divider line
  const x = Math.round(p * W), feather = Math.max(3, Math.floor(W / 120));
  oc.drawImage(before, 0, 0);
  if (x <= 0) return;
  oc.save();
  oc.beginPath(); oc.rect(0, 0, x, H); oc.clip();
  oc.drawImage(after, 0, 0);
  oc.restore();
  // feathered band: before -> fade over the last `feather` px
  const x0 = Math.max(0, x - feather);
  const g = oc.createLinearGradient(x0, 0, x, 0);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)');
  oc.save();
  oc.beginPath(); oc.rect(x0, 0, x - x0, H); oc.clip();
  oc.globalAlpha = 1;
  // draw "before" over the band with increasing opacity
  const tmp = document.createElement('canvas');
  tmp.width = x - x0 || 1; tmp.height = H;
  const tc = tmp.getContext('2d');
  tc.drawImage(before, x0, 0, tmp.width, H, 0, 0, tmp.width, H);
  tc.globalCompositeOperation = 'destination-in';
  const g2 = tc.createLinearGradient(0, 0, tmp.width, 0);
  g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(1, 'rgba(0,0,0,1)');
  tc.fillStyle = g2; tc.fillRect(0, 0, tmp.width, H);
  oc.drawImage(tmp, x0, 0);
  oc.restore();
  const lw = Math.max(2, Math.floor(W / 500));
  oc.fillStyle = '#fff';
  oc.fillRect(Math.max(0, x - Math.floor(lw / 2)), 0, lw, H);
}

async function encodeAudio(muxer, buf, cfg, hold, duration) {
  let err = null;
  const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => { err = e; } });
  aenc.configure(cfg);
  const sr = buf.sampleRate, ch = cfg.numberOfChannels;
  const src = [...Array(ch)].map((_, i) => buf.getChannelData(Math.min(i, buf.numberOfChannels - 1)));
  const totalFrames = Math.round((hold + duration) * sr), holdFrames = Math.round(hold * sr);
  const CH = 4096;
  for (let pos = 0; pos < totalFrames; pos += CH) {
    if (err) throw err;
    const nfr = Math.min(CH, totalFrames - pos);
    const data = new Float32Array(nfr * ch);
    for (let c = 0; c < ch; c++) {
      const s = src[c];
      for (let i = 0; i < nfr; i++) {
        const k = pos + i - holdFrames; // audio starts with the wipe, loops like the video
        data[c * nfr + i] = k < 0 ? 0 : s[k % s.length];
      }
    }
    const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: nfr, numberOfChannels: ch, timestamp: Math.round((pos * 1e6) / sr), data });
    aenc.encode(ad);
    ad.close();
  }
  await aenc.flush();
  aenc.close();
}
