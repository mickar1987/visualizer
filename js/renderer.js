// WebGL2 renderer: background photo + screens warped in perspective (homography per pixel).
import { squareToQuad, invert3 } from './geom.js';

const VS_BG = `#version 300 es
in vec2 aPos; uniform vec4 uView; uniform vec2 uSize; uniform vec2 uCanvas; out vec2 vUv;
void main(){ vec2 p = aPos * uSize; vUv = aPos;
  vec2 s = p * uView.x + uView.yz; gl_Position = vec4(s.x / uCanvas.x * 2.0 - 1.0, 1.0 - s.y / uCanvas.y * 2.0, 0, 1); }`;
const FS_BG = `#version 300 es
precision highp float; in vec2 vUv; uniform sampler2D uTex; out vec4 o;
void main(){ o = vec4(texture(uTex, vUv).rgb, 1.0); }`;

const VS_SCR = `#version 300 es
in vec2 aPos; uniform vec4 uView; uniform vec2 uCanvas; out vec2 vImg;
void main(){ vImg = aPos; vec2 s = aPos * uView.x + uView.yz;
  gl_Position = vec4(s.x / uCanvas.x * 2.0 - 1.0, 1.0 - s.y / uCanvas.y * 2.0, 0, 1); }`;
const FS_SCR = `#version 300 es
precision highp float; in vec2 vImg; uniform mat3 uHinv; uniform vec2 uBezel; uniform vec2 uFit;
uniform float uBright; uniform int uHasTex; uniform sampler2D uTex; out vec4 o;
const vec3 BEZEL = vec3(14.0/255.0); const vec3 OFF = vec3(24.0/255.0, 26.0/255.0, 28.0/255.0);
void main(){
  vec3 q = uHinv * vec3(vImg, 1.0); vec2 uv = q.xy / q.z;
  if (uv.x < -0.002 || uv.y < -0.002 || uv.x > 1.002 || uv.y > 1.002) discard;
  vec2 a = (uv - uBezel) / (1.0 - 2.0 * uBezel);
  vec3 col;
  if (a.x < 0.0 || a.y < 0.0 || a.x > 1.0 || a.y > 1.0) col = BEZEL;
  else if (uHasTex == 0) col = OFF;
  else { vec2 c = 0.5 + (a - 0.5) * uFit;
    if (c.x < 0.0 || c.y < 0.0 || c.x > 1.0 || c.y > 1.0) col = vec3(0.0);
    else col = min(texture(uTex, c).rgb * uBright, vec3(1.0)); }
  o = vec4(col, 1.0);
}`;

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const nm = gl.getActiveUniform(p, i).name; u[nm] = gl.getUniformLocation(p, nm); }
  return { p, u };
}

/** fit scale vector: content uv = 0.5 + (active uv - 0.5) * fit */
export function fitVector(mode, contentAspect, activeAspect) {
  if (mode === 'stretch' || !contentAspect) return [1, 1];
  const rc = contentAspect, ra = activeAspect;
  if (mode === 'fill') return rc > ra ? [ra / rc, 1] : [1, rc / ra];
  return rc > ra ? [1, rc / ra] : [ra / rc, 1]; // fit (black bars)
}

export class Renderer {
  constructor(canvas, { preserve = false } = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: preserve, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;
    this.bg = compile(gl, VS_BG, FS_BG);
    this.scr = compile(gl, VS_SCR, FS_SCR);
    this.unitBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);
    this.quadBuf = gl.createBuffer();
    this.textures = new Map(); // key -> {tex, src, w, h, version}
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  }

  /** Upload (or re-upload when version changes) a texture from an image/canvas/video/bitmap. */
  texture(key, src, version = 0, mipmap = true) {
    const gl = this.gl;
    let t = this.textures.get(key);
    if (t && t.src === src && t.version === version) return t.tex;
    if (!t) {
      t = { tex: gl.createTexture() };
      this.textures.set(key, t);
    }
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (mipmap) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    t.src = src; t.version = version;
    return t.tex;
  }

  drop(key) {
    const t = this.textures.get(key);
    if (t) { this.gl.deleteTexture(t.tex); this.textures.delete(key); }
  }

  /**
   * scene: {bg: {src, w, h, version}, screens: [{corners, bezel:[bx,by], fit:[fx,fy], bright, tex:{key,src,version,mipmap}|null}]}
   * view: {zoom, x, y} image->canvas pixels (device pixels)
   */
  draw(scene, view) {
    const gl = this.gl, cw = this.canvas.width, ch = this.canvas.height;
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0.13, 0.13, 0.14, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!scene.bg) return;
    const vu = [view.zoom, view.x, view.y, 0];

    gl.useProgram(this.bg.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture('bg', scene.bg.src, scene.bg.version));
    gl.uniform1i(this.bg.u.uTex, 0);
    gl.uniform4fv(this.bg.u.uView, vu);
    gl.uniform2f(this.bg.u.uSize, scene.bg.w, scene.bg.h);
    gl.uniform2f(this.bg.u.uCanvas, cw, ch);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.useProgram(this.scr.p);
    gl.uniform4fv(this.scr.u.uView, vu);
    gl.uniform2f(this.scr.u.uCanvas, cw, ch);
    gl.uniform1i(this.scr.u.uTex, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    for (const s of scene.screens) {
      const H = squareToQuad(s.corners);
      const Hi = invert3(H);
      if (!Hi) continue;
      // mat3 uniform is column-major
      gl.uniformMatrix3fv(this.scr.u.uHinv, false, [Hi[0], Hi[3], Hi[6], Hi[1], Hi[4], Hi[7], Hi[2], Hi[5], Hi[8]]);
      gl.uniform2fv(this.scr.u.uBezel, s.bezel);
      gl.uniform2fv(this.scr.u.uFit, s.fit);
      gl.uniform1f(this.scr.u.uBright, s.bright);
      if (s.tex) {
        gl.bindTexture(gl.TEXTURE_2D, this.texture(s.tex.key, s.tex.src, s.tex.version, s.tex.mipmap !== false));
        gl.uniform1i(this.scr.u.uHasTex, 1);
      } else gl.uniform1i(this.scr.u.uHasTex, 0);
      const c = s.corners;
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([c[0].x, c[0].y, c[1].x, c[1].y, c[2].x, c[2].y,
        c[0].x, c[0].y, c[2].x, c[2].y, c[3].x, c[3].y]), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  destroy() {
    for (const k of [...this.textures.keys()]) this.drop(k);
    const ext = this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}
