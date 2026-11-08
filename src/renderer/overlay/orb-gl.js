// COre's body, "liquid" style (orb.style = "liquid"): a raymarched black liquid orb.
//
// Technique: signed distance fields + smooth union, after Inigo Quilez's
// articles (iquilezles.org/articles/distfunctions, /smin). The body is a
// displaced sphere, the "tail" a lagging sphere that makes motion look liquid,
// and each arm is a chain of tapered round cones (iq's sdRoundCone) melted
// into the body. Orthographic camera in screen pixels, so a hand pointing at
// pixel (x, y) really touches (x, y). Pixels far from any shape exit early.
(function (root) {
  'use strict';

  const VERT = `#version 300 es
  in vec2 aPos;
  void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const FRAG = `#version 300 es
  precision highp float;
  out vec4 outColor;

  uniform float uTime;
  uniform float uScale;   // device px per css px
  uniform vec3  uOrb;     // x, y (device px, y up), radius
  uniform vec2  uVel;     // device px / s, y up
  uniform vec3  uTail;    // x, y, radius
  uniform float uAmp;     // speaking energy 0..1
  uniform float uListen;  // mic level 0..1
  uniform float uThink;   // 0..1
  uniform vec3  uTint;    // state colour
  uniform float uGlow;    // rim glow 0..1
  uniform float uHalo;    // attention halo 0..1
  uniform vec2  uArmP[8]; // arm i: points [i*4 .. i*4+3]
  uniform vec4  uArmR[2]; // arm radii
  uniform float uArmOn[2];

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                   mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                   mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float smin(float a, float b, float k) {
    float h = max(k - abs(a - b), 0.0) / k;
    return min(a, b) - h * h * k * 0.25;
  }
  float dot2(vec3 v) { return dot(v, v); }
  // Inigo Quilez, "Round Cone - exact" (MIT).
  float sdRoundCone(vec3 p, vec3 a, vec3 b, float r1, float r2) {
    vec3 ba = b - a;
    float l2 = dot(ba, ba);
    float rr = r1 - r2;
    float a2 = l2 - rr * rr;
    if (l2 < 1e-3 || a2 <= 0.0) return length(p - (r1 > r2 ? a : b)) - max(r1, r2);
    float il2 = 1.0 / l2;
    vec3 pa = p - a;
    float y = dot(pa, ba);
    float z = y - l2;
    float x2 = dot2(pa * l2 - ba * y);
    float y2 = y * y * l2;
    float z2 = z * z * l2;
    float k = sign(rr) * rr * rr * x2;
    if (sign(z) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - r2;
    if (sign(y) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - r1;
    return (sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
  }
  float sdSeg2(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
    return length(pa - ba * h);
  }

  float body(vec3 p) {
    float R = uOrb.z;
    vec3 q = p - vec3(uOrb.xy, 0.0);
    float sp = length(uVel);
    vec2 dir = sp > 1.0 ? uVel / sp : vec2(1.0, 0.0);
    float s = 1.0 + clamp(sp / (R * 30.0), 0.0, 0.5);      // stretch along motion
    float ss = sqrt(s);
    vec2 a = vec2(dot(q.xy, dir), dot(q.xy, vec2(-dir.y, dir.x)));
    vec3 qs = vec3(a.x / s, a.y * ss, q.z * ss);             // volume-ish preserving
    float l = length(qs);
    vec3 n = qs / max(l, 1e-4);
    float t = uTime;
    float breathe = 0.012 * sin(t * 1.4);
    float idle = 0.022 * (noise(n * 2.2 + vec3(0.0, 0.0, t * 0.35)) - 0.5);
    float talk = uAmp * (0.085 * (noise(n * 4.5 + vec3(t * 3.1, -t * 2.3, t * 5.0)) - 0.5)
               + 0.032 * sin(11.0 * n.y + t * 19.0) * sin(8.0 * n.x - t * 15.0));
    float ripple = uListen * 0.04 * sin(length(n.xy) * 16.0 - t * 9.0) * smoothstep(0.2, 0.9, n.z);
    // The swirl uses the angle around the view axis, which is undefined where the
    // surface faces the camera, so fade it out there (no star-shaped pinch).
    float think = uThink * 0.022 * sin(atan(n.y, n.x) * 5.0 + t * 3.0) * smoothstep(0.15, 0.7, length(n.xy));
    return (l - R * (1.0 + breathe + idle + talk + ripple + think)) / ss;
  }

  float map(vec3 p) {
    float R = uOrb.z;
    float d = body(p);
    d = smin(d, length(p - vec3(uTail.xy, 0.0)) - uTail.z, R * 0.8);
    for (int i = 0; i < 2; i++) {
      if (uArmOn[i] < 0.02) continue;
      vec4 rr = uArmR[i];
      vec3 p0 = vec3(uArmP[i * 4 + 0], 0.0);
      vec3 p1 = vec3(uArmP[i * 4 + 1], 0.0);
      vec3 p2 = vec3(uArmP[i * 4 + 2], 0.0);
      vec3 p3 = vec3(uArmP[i * 4 + 3], 0.0);
      float da = sdRoundCone(p, p0, p1, rr.x, rr.y);
      da = smin(da, sdRoundCone(p, p1, p2, rr.y, rr.z), R * 0.12);
      da = smin(da, sdRoundCone(p, p2, p3, rr.z, rr.w), R * 0.1);
      d = smin(d, da, R * 0.45);
    }
    return d;
  }

  float bound2D(vec2 f) {
    float R = uOrb.z;
    float b = length(f - uOrb.xy) - R * 1.8;
    b = min(b, length(f - uTail.xy) - uTail.z - R * 0.4);
    for (int i = 0; i < 2; i++) {
      if (uArmOn[i] < 0.02) continue;
      float w = max(max(uArmR[i].x, uArmR[i].y), max(uArmR[i].z, uArmR[i].w)) + R * 0.25;
      b = min(b, sdSeg2(f, uArmP[i*4+0], uArmP[i*4+1]) - w);
      b = min(b, sdSeg2(f, uArmP[i*4+1], uArmP[i*4+2]) - w);
      b = min(b, sdSeg2(f, uArmP[i*4+2], uArmP[i*4+3]) - w);
    }
    return b;
  }

  vec3 calcNormal(vec3 p) {
    float e = 0.6 * uScale;
    vec2 k = vec2(1.0, -1.0);
    return normalize(k.xyy * map(p + k.xyy * e) + k.yyx * map(p + k.yyx * e) +
                     k.yxy * map(p + k.yxy * e) + k.xxx * map(p + k.xxx * e));
  }

  vec3 shade(vec3 n) {
    vec3 v = vec3(0.0, 0.0, 1.0);
    vec3 r = reflect(-v, n);
    float nz = clamp(n.z, 0.0, 1.0);
    float fres = pow(1.0 - nz, 3.0);
    // A small virtual photo studio reflected in the obsidian surface.
    float sky = smoothstep(-0.3, 1.0, r.y);
    vec3 env = mix(vec3(0.012, 0.012, 0.016), vec3(0.15, 0.15, 0.18), sky);
    float key = smoothstep(0.86, 0.97, dot(r, normalize(vec3(-0.5, 0.6, 0.62))));
    float strip = smoothstep(0.90, 0.985, dot(r, normalize(vec3(0.78, -0.05, 0.62))));
    float bounce = smoothstep(0.2, -0.9, r.y) * 0.06;
    env += vec3(1.0) * key * 1.4 + uTint * strip * (0.55 + 0.9 * uGlow) + uTint * bounce;

    vec3 col = vec3(0.003, 0.003, 0.005);
    col += env * mix(0.04, 1.0, fres);
    vec3 L = normalize(vec3(-0.5, 0.65, 0.75));
    float nh = max(dot(n, normalize(L + v)), 0.0);
    col += vec3(1.0) * pow(nh, 220.0) * 1.9;
    col += vec3(0.55) * pow(nh, 22.0) * 0.05;
    float rim = pow(1.0 - nz, 2.2);
    col += uTint * rim * (0.06 + 0.8 * uGlow);
    col += uTint * uAmp * 0.4 * pow(rim, 1.4) * (0.55 + 0.45 * noise(n * 6.0 + uTime * 4.0));
    col += uTint * uThink * 0.28 * rim * (0.5 + 0.5 * sin(atan(n.y, n.x) * 3.0 - uTime * 4.0)) * smoothstep(0.1, 0.5, length(n.xy));
    col += uTint * uHalo * 0.35 * rim;
    col = col / (1.0 + col);
    return pow(col, vec3(0.4545));
  }

  void main() {
    vec2 f = gl_FragCoord.xy;
    float R = uOrb.z;
    float margin = R * (0.45 + 1.4 * uHalo);
    if (bound2D(f) > margin) { outColor = vec4(0.0); return; }

    vec3 ro = vec3(f, R * 2.2);
    float t = 0.0;
    float minD = 1e9;
    bool hit = false;
    vec3 p = ro;
    for (int i = 0; i < 72; i++) {
      p = ro - vec3(0.0, 0.0, t);
      float d = map(p);
      minD = min(minD, d);
      if (d < 0.35 * uScale) { hit = true; break; }
      t += d * 0.8;
      if (t > R * 4.6) break;
    }

    if (hit) {
      outColor = vec4(shade(calcNormal(p)), 1.0);
      return;
    }
    // Outside the body: anti-aliased edge, attention halo, soft contact shadow.
    float edge = 1.0 - smoothstep(0.0, 1.4 * uScale, minD);
    float pulse = 0.72 + 0.28 * sin(uTime * 5.0);
    float halo = uHalo * pulse * exp(-max(minD, 0.0) / (R * 0.42));
    vec2 sc = (f - vec2(uOrb.x, uOrb.y - R * 1.18)) / vec2(R * 1.0, R * 0.22);
    float shadow = 0.2 * exp(-dot(sc, sc) * 1.5);
    vec3 rgb = uTint * halo * 0.9 + (vec3(0.02) + uTint * uGlow * 0.35) * edge;
    float a = clamp(halo * 0.85 + shadow + edge, 0.0, 1.0);
    outColor = vec4(rgb, a);
  }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(`shader compile failed: ${log}`);
    }
    return s;
  }

  class OrbRenderer {
    constructor(canvas, { renderScale = 1 } = {}) {
      this.canvas = canvas;
      this.renderScale = renderScale;
      const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
      if (!gl) throw new Error('WebGL2 is not available');
      this.gl = gl;
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      this.prog = prog;
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.u = {};
      for (const name of ['uTime', 'uScale', 'uOrb', 'uVel', 'uTail', 'uAmp', 'uListen', 'uThink',
        'uTint', 'uGlow', 'uHalo', 'uArmP', 'uArmR', 'uArmOn']) {
        this.u[name] = gl.getUniformLocation(prog, name);
      }
      this.armP = new Float32Array(16);
      this.armR = new Float32Array(8);
      this.armOn = new Float32Array(2);
      this.resize();
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.renderScale;
      const w = Math.max(1, Math.round(window.innerWidth * dpr));
      const h = Math.max(1, Math.round(window.innerHeight * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      this.sc = w / window.innerWidth;
      this.gl.viewport(0, 0, w, h);
    }

    // s: { t, pos, vel, tail, tailR, r, amp, listen, think, tint[3], glow, halo, arms:[geom|null, geom|null] }
    render(s) {
      const gl = this.gl;
      const sc = this.sc;
      const H = this.canvas.height;
      const X = (x) => x * sc;
      const Y = (y) => H - y * sc;
      gl.useProgram(this.prog);
      gl.uniform1f(this.u.uTime, s.t);
      gl.uniform1f(this.u.uScale, sc);
      gl.uniform3f(this.u.uOrb, X(s.pos.x), Y(s.pos.y), s.r * sc);
      gl.uniform2f(this.u.uVel, s.vel.x * sc, -s.vel.y * sc);
      gl.uniform3f(this.u.uTail, X(s.tail.x), Y(s.tail.y), s.tailR * sc);
      gl.uniform1f(this.u.uAmp, s.amp);
      gl.uniform1f(this.u.uListen, s.listen);
      gl.uniform1f(this.u.uThink, s.think);
      gl.uniform3f(this.u.uTint, s.tint[0], s.tint[1], s.tint[2]);
      gl.uniform1f(this.u.uGlow, s.glow);
      gl.uniform1f(this.u.uHalo, s.halo);
      for (let i = 0; i < 2; i++) {
        const g = s.arms[i];
        this.armOn[i] = g ? g.on : 0;
        for (let k = 0; k < 4; k++) {
          this.armP[i * 8 + k * 2] = g ? X(g.pts[k].x) : 0;
          this.armP[i * 8 + k * 2 + 1] = g ? Y(g.pts[k].y) : 0;
          this.armR[i * 4 + k] = g ? g.radii[k] * sc : 0;
        }
      }
      gl.uniform2fv(this.u.uArmP, this.armP);
      gl.uniform4fv(this.u.uArmR, this.armR);
      gl.uniform1fv(this.u.uArmOn, this.armOn);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  root.LiquidOrbRenderer = OrbRenderer;
})(window);
