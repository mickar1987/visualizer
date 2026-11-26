// Device detection: phone / tablet -> "mobile" mode, otherwise "desktop".
// Can be overridden in Settings (stored per browser).
const KEY = 'viz.device';

export function detectMobile() {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const ipadOS = navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent);
  const uaMobile = /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent);
  return ipadOS || uaMobile || (coarse && !matchMedia('(any-pointer: fine)').matches);
}

export function deviceSetting() {
  try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; }
}
export function setDeviceSetting(v) {
  try { localStorage.setItem(KEY, v); } catch { /* ignore */ }
}

export const MOBILE = deviceSetting() === 'mobile' || (deviceSetting() === 'auto' && detectMobile());

/** What each mode can do. */
export const CAPS = {
  mobile: MOBILE,
  video: !MOBILE,   // video content, preview playback and MP4 export
  quote: !MOBILE,   // LED Quote hand-off
  // largest background kept in memory (long side, px)
  maxImage: MOBILE ? 4096 : 8192,
};
