// COre's body, "smoke" style: thousands of glowing particles that flow over a
// spherical shell, bunch into filaments, puff outward and resonate together.
//
// How it works (all on the GPU, WebGL2):
//  1. Simulation: particle state (position, velocity, life) lives in buffers
//     updated every frame with transform feedback. Each particle is carried by
//     a divergence-free flow on the sphere: cross(normal, gradient(noise)).
//     That swirling field is what gathers particles into the drifting
//     filaments. A soft spring keeps them on the shell, so when the orb moves
//     they lag behind like smoke.
//  2. Arms: while an arm is out, a share of the particles leaves the shell and
//     streams along the arm curve toward the fingertip.
//  3. Trails: particles are drawn additively into an offscreen buffer that
//     fades a little each frame, turning motion into smoke streaks.
//  4. Composite: the buffer is tone-mapped with a cheap mip-map bloom, over a
//     faint dark aura so the glow reads on light wallpapers too.
//
// Simplex noise with analytic gradient: Ian McEwan & Stefan Gustavson
// (ashima/webgl-noise, MIT).
(function (root) {
  'use strict';

  const NOISE = `
  vec4 permute(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
  float snoiseGrad(vec3 v, out vec3 gradient) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod(i, 289.0);
    vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    vec4 m2 = m * m;
    vec4 m4 = m2 * m2;
    vec4 pdotx = vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3));
    vec4 temp = m2 * m * pdotx;
    gradient = -8.0 * (temp.x * x0 + temp.y * x1 + temp.z * x2 + temp.w * x3);
    gradient += m4.x * p0 + m4.y * p1 + m4.z * p2 + m4.w * p3;
    gradient *= 42.0;
    return 42.0 * dot(m4, pdotx);
  }
  vec3 hash31(float p) {
    vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xxy + p3.yzz) * p3.zyx);
  }
  vec3 randDir(float s) {
    vec3 h = hash31(s);
    float z = h.x * 2.0 - 1.0;
    float a = h.y * 6.2831853;
    float r = sqrt(max(0.0, 1.0 - z * z));
    return vec3(r * cos(a), r * sin(a), z);
  }`;

  // ---------------------------------------------------------------- simulate
  const SIM_VS = `#version 300 es
  precision highp float;
  in vec3 aPos;
  in vec3 aVel;
  in vec4 aMeta;          // life, seed, maxLife, layer (0 shell / 1 inner dust)
  out vec3 oPos;
  out vec3 oVel;
  out vec4 oMeta;
  uniform float uTime;
  uniform float uDt;
  uniform vec3  uCenter;  // css px
  uniform vec2  uCenterVel;
  uniform float uR;
  uniform float uAmp;
  uniform float uListen;
  uniform float uThink;
  uniform float uFlow;
  uniform vec2  uArmP[8];
  uniform vec4  uArmR[2];
  uniform float uArmOn[2];
  uniform float uArmMode[2]; // 0 = pointing (index finger out), 1 = open explaining hand
  ${NOISE}

  vec2 rot2(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(v.x * c - v.y * s, v.x * s + v.y * c); }

  // Finger layout: angle (radians, relative to the arm direction) and length
  // (fraction of hand size). Thumb first.
  void fingerSpec(int f, float mode, out float ang, out float len) {
    if (mode > 0.5) {           // open hand
      if (f == 0) { ang = -1.08; len = 0.55; }
      else if (f == 1) { ang = -0.48; len = 0.86; }
      else if (f == 2) { ang = 0.0; len = 0.96; }
      else if (f == 3) { ang = 0.45; len = 0.86; }
      else { ang = 0.9; len = 0.64; }
    } else {                    // pointing: index straight, the rest curled
      if (f == 0) { ang = -0.95; len = 0.42; }
      else if (f == 1) { ang = 0.0; len = 1.0; }
      else if (f == 2) { ang = 0.62; len = 0.3; }
      else if (f == 3) { ang = 1.05; len = 0.27; }
      else { ang = 1.45; len = 0.24; }
    }
  }

  mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
  mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }

  void main() {
    float life = aMeta.x - uDt;
    float seed = aMeta.y;
    float maxLife = aMeta.z;
    float layer = floor(aMeta.w + 0.01);
    vec3 pos = aPos;
    vec3 vel = aVel;
    vec3 h = hash31(seed * 977.3);

    if (life <= 0.0 || maxLife <= 0.0) {
      vec3 hr = hash31(seed * 1731.3 + uTime * 17.7);
      vec3 d = randDir(seed * 4211.9 + uTime * 31.1);
      float rr = layer > 0.5 ? mix(0.15, 0.92, hr.x) : (0.95 + 0.08 * hr.x);
      pos = uCenter + d * uR * rr;
      vel = vec3(uCenterVel, 0.0);
      maxLife = mix(2.5, 7.0, hr.y);
      life = maxLife;
    }

    // Which particles currently belong to an arm (share grows with extension).
    int arm = -1;
    const float SHARE = 0.24;
    if (uArmOn[0] > 0.03 && seed < SHARE * min(uArmOn[0], 1.0)) arm = 0;
    else if (uArmOn[1] > 0.03 && seed > 1.0 - SHARE * min(uArmOn[1], 1.0)) arm = 1;

    float tipFlag = 0.0;
    if (arm >= 0) {
      float mode = uArmMode[arm];
      float side = arm == 0 ? -1.0 : 1.0;
      float grow = clamp(uArmOn[arm], 0.0, 1.0);
      float hs = uR * 0.5 * grow;                       // hand size
      vec2 tip = uArmP[arm * 4 + 3];
      vec2 adir = normalize(tip - uArmP[arm * 4 + 2] + vec2(1e-4));
      // Pointing: the index fingertip lands on the target, so the palm sits
      // one finger-length back along the arm. Open hand: palm at the tip.
      vec2 palm = mode > 0.5 ? tip : tip - adir * hs * 1.25;
      vec3 h2 = hash31(seed * 71.3);
      vec3 target;
      bool wrapped = false;

      if (h2.x < 0.5) {
        // Forearm: three thin strands twisting from the body to the palm.
        float rate = 0.6 + 0.4 * h.x;
        float s = fract(seed * 13.7 + uTime * rate);
        wrapped = s < fract(seed * 13.7 + (uTime - uDt) * rate);
        float f = s * 2.999;
        int seg = int(floor(f));
        float u = f - float(seg);
        vec2 a = uArmP[arm * 4 + seg];
        vec2 b = seg == 2 ? palm : uArmP[arm * 4 + seg + 1];
        float rad = mix(uArmR[arm][seg], uArmR[arm][min(seg + 1, 3)], u) * (1.0 - 0.5 * s);
        vec2 dir = normalize(b - a + vec2(1e-4));
        vec2 perp = vec2(-dir.y, dir.x);
        float strandId = floor(h.y * 3.0);
        float ang = strandId * 2.0943951 + s * 9.0 - uTime * 2.2;
        float twist = rad * 0.55;
        vec2 jitter = vec2(hash31(seed * 57.1).xy - 0.5) * rad * 0.18;
        target = vec3(mix(a, b, u) + perp * cos(ang) * twist + jitter, sin(ang) * twist);
      } else if (h2.x < 0.66) {
        // Palm: a small swirling cloud, flattened across the arm.
        float a = h2.y * 6.2831853 + uTime * (0.25 + 0.3 * h2.z);
        float rr = sqrt(h2.z) * (0.7 + 0.3 * sin(uTime * 1.7 + h2.y * 20.0));
        vec2 local = vec2(cos(a) * hs * 0.26, sin(a) * hs * 0.36) * rr;
        target = vec3(palm + rot2(local, atan(adir.y, adir.x)), sin(a * 2.0) * hs * 0.12);
      } else {
        // Fingers: smoke flows from the knuckle to the fingertip.
        int fi = int(floor(h2.y * 4.999));
        float fang, flen;
        fingerSpec(fi, mode, fang, flen);
        float flex = mode > 0.5 ? sin(uTime * 2.6 + float(fi) * 1.3) * 0.12 : sin(uTime * 3.0) * 0.03;
        vec2 fdir = rot2(adir, side * (fang + flex));
        vec2 fperp = vec2(-fdir.y, fdir.x);
        float rate = 0.9 + 0.6 * h2.z;
        float t = fract(seed * 29.1 + uTime * rate);
        wrapped = t < fract(seed * 29.1 + (uTime - uDt) * rate);
        vec2 knuckle = palm + fdir * hs * 0.3;
        float L = flen * hs;
        float curl = (mode > 0.5 ? 0.12 : (fi == 1 ? 0.02 : 0.35)) * L;
        float width = hs * 0.055 * (1.0 - 0.55 * t);
        vec2 jit = (hash31(seed * 91.7).xy - 0.5) * width * 2.0;
        target = vec3(knuckle + fdir * L * t + fperp * side * curl * sin(t * 3.14159) + jit,
                      (h2.z - 0.5) * width * 2.0);
        tipFlag = t > 0.86 ? 0.5 : 0.0;
      }

      if (wrapped) { pos = target; vel = vec3(0.0); }
      vel += (target - pos) * 80.0 * uDt;
      vel *= exp(-uDt * 11.0);
      pos += vel * uDt;
      life = max(life, 0.6);
    } else {
      vec3 rel = pos - uCenter;
      float r = max(length(rel), 1e-3);
      vec3 n = rel / r;
      // Sample the flow in a slowly tumbling frame: the whole cloud seems to turn.
      mat3 spin = rotY(uTime * 0.22) * rotX(sin(uTime * 0.13) * 0.5);
      vec3 q = spin * n;
      vec3 g1; float n1 = snoiseGrad(q * 0.95 + vec3(0.0, 0.0, uTime * 0.09), g1);
      vec3 g2; float n2 = snoiseGrad(q * 2.6 + vec3(uTime * 0.15, 3.7, 0.0), g2);
      vec3 gw1 = transpose(spin) * g1;
      vec3 gw2 = transpose(spin) * g2;
      // Swirl along the noise isolines (divergence-free, keeps things moving)...
      vec3 flow = cross(n, gw1) + 0.45 * cross(n, gw2);
      // ...plus, for most particles, a pull toward the zero-lines of the noise.
      // The swirl runs along those same lines, so particles gather into thin
      // drifting filaments, the wispy strands of the reference look.
      vec3 gt1 = gw1 - n * dot(n, gw1);
      vec3 gt2 = gw2 - n * dot(n, gw2);
      float strand = step(0.35, h.y);          // ~65% strands, the rest haze
      flow += strand * (-n1 * gt1 * 2.2 - n2 * gt2 * 0.12);
      flow += cross(vec3(0.0, 1.0, 0.0), n) * uThink * 1.4;
      float speed = uFlow * uR * (1.0 + 1.8 * uAmp + 0.9 * uThink + 0.6 * uListen);

      // Shell: breathing, smoke puffs where the noise peaks, and resonance modes.
      float puff = pow(max(n1, 0.0), 3.0);
      float modes = sin(n.x * 7.0 + uTime * 9.0) * sin(n.y * 6.0 - uTime * 7.0) * sin(n.z * 5.0 + uTime * 11.0);
      float ripple = sin(n.z * 10.0 - uTime * 12.0);
      float shell = layer > 0.5 ? mix(0.2, 0.9, h.x) : (1.0 + (h.x - 0.5) * 0.05);
      float targetR = uR * (shell + 0.025 * sin(uTime * 1.3 + h.y)
                    + puff * strand * (0.16 + 0.3 * uAmp)
                    + uAmp * 0.12 * modes
                    + uListen * 0.07 * ripple);
      vec3 desired = flow * speed * (layer > 0.5 ? 0.35 : 1.0)
                   + n * (targetR - r) * 5.0
                   + vec3(uCenterVel, 0.0);
      // Each particle catches up at its own pace, so a moving orb trails a
      // diffuse smoke tail instead of a stack of coherent shell outlines.
      float respond = mix(2.2, 7.5, fract(seed * 517.3));
      vel = mix(vel, desired, 1.0 - exp(-uDt * respond));
      pos += vel * uDt;
    }

    oPos = pos;
    oVel = vel;
    oMeta = vec4(life, seed, maxLife, layer + tipFlag);
  }`;

  const SIM_FS = `#version 300 es
  precision mediump float;
  out vec4 o;
  void main() { o = vec4(0.0); }`;

  // ---------------------------------------------------------------- draw points
  const PT_VS = `#version 300 es
  precision highp float;
  in vec3 aPos;
  in vec4 aMeta;
  out vec4 vCol;
  uniform vec2  uView;   // css px
  uniform float uPx;     // device px per css px
  uniform float uSize;
  uniform float uR;
  uniform float uTime;
  uniform vec3  uTint;
  uniform float uAmp;
  uniform float uGlow;
  uniform float uBright;
  void main() {
    gl_Position = vec4(aPos.x / uView.x * 2.0 - 1.0, 1.0 - aPos.y / uView.y * 2.0, 0.0, 1.0);
    float life = aMeta.x, seed = aMeta.y, maxL = aMeta.z;
    float fade = smoothstep(0.0, 0.9, life) * smoothstep(0.0, 0.6, maxL - life);
    float front = 0.45 + 0.55 * smoothstep(-1.0, 1.0, aPos.z / uR);
    float spark = step(0.990, fract(seed * 7919.37));
    float dust = floor(aMeta.w + 0.01);
    float tipGlow = step(0.25, fract(aMeta.w + 0.01));
    float twinkle = 0.55 + 0.45 * sin(uTime * (2.0 + 6.0 * fract(seed * 53.1)) + seed * 91.0);
    gl_PointSize = max(1.0, uSize * uPx * (0.5 + 0.8 * fract(seed * 311.7)) * (1.0 + 0.6 * spark));
    vec3 col = mix(uTint, vec3(1.0), 0.3 * spark + 0.1 * uAmp);
    float a = fade * front * (0.022 * (1.0 - 0.5 * dust) * (1.0 + 4.0 * tipGlow) + 0.22 * spark * twinkle) * (1.0 + 1.1 * uAmp + 0.6 * uGlow) * uBright;
    vCol = vec4(col * a, a);
  }`;

  const PT_FS = `#version 300 es
  precision mediump float;
  in vec4 vCol;
  out vec4 o;
  void main() {
    vec2 d = gl_PointCoord * 2.0 - 1.0;
    float m = exp(-dot(d, d) * 3.5);
    o = vCol * m;
  }`;

  // ---------------------------------------------------------------- full-screen passes
  const QUAD_VS = `#version 300 es
  in vec2 aQuad;
  out vec2 vUv;
  void main() { vUv = aQuad * 0.5 + 0.5; gl_Position = vec4(aQuad, 0.0, 1.0); }`;

  const FADE_FS = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 o;
  uniform sampler2D uPrev;
  uniform float uKeep;
  uniform float uFloor;
  uniform vec2 uShift;   // how far the orb moved since last frame, in uv
  // Trails live in the orb's own frame: last frame's smoke moves with COre,
  // so dragging or flying it never stamps ghost copies across the screen.
  void main() {
    vec2 uv = vUv - uShift;
    // Outside the texture there is no old smoke (clamping would smear the edge).
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { o = vec4(0.0); return; }
    o = max(texture(uPrev, uv) * uKeep - uFloor, 0.0);
  }`;

  const COMP_FS = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 o;
  uniform sampler2D uTex;
  uniform vec2  uCenterPx;   // device px, y up
  uniform float uRPx;
  uniform vec3  uTint;
  uniform float uHalo;
  uniform float uAura;
  uniform float uTime;
  uniform float uLight;      // 0 dark wallpaper look, 1 light wallpaper look
  void main() {
    vec3 c = texture(uTex, vUv).rgb;
    vec3 bloom = textureLod(uTex, vUv, 1.5).rgb * 0.35 + textureLod(uTex, vUv, 3.0).rgb * 0.3;
    vec3 glow = 1.0 - exp(-(c * 1.4 + bloom) * 1.3);
    float d = length(gl_FragCoord.xy - uCenterPx) / uRPx;
    // A dark smoky core behind the sphere (flat inside, quick falloff), plus a
    // soft shadow under every glowing strand taken from the bloom, so the glow
    // stays readable on light wallpapers as well as dark ones.
    float aura = uAura * exp(-pow(d / 1.2, 4.0));
    float smoke = clamp(dot(bloom, vec3(0.6)) * 2.2, 0.0, 0.55);
    float halo = uHalo * exp(-pow((d - 1.3) / 0.32, 2.0)) * (0.65 + 0.35 * sin(uTime * 5.0));
    vec3 rgb = glow + uTint * halo * 0.55;
    float lum = max(max(rgb.r, rgb.g), rgb.b);
    float aDark = clamp(lum + max(aura, smoke), 0.0, 1.0);
    // Light wallpaper: no cast shadow, just faint dark glass inside the shell,
    // and strands drawn more opaque and a touch deeper so the green reads.
    float glass = 0.22 * smoothstep(1.02, 0.6, d);
    vec3 rgbLight = rgb * 0.8;
    float aLight = clamp(lum * 1.9 + glass + uTint.g * halo * 0.2, 0.0, 0.95);
    rgb = mix(rgb, rgbLight, uLight);
    float a = mix(aDark, aLight, uLight);
    o = vec4(min(rgb, vec3(a)), a);
  }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      throw new Error(`shader compile failed: ${log}`);
    }
    return s;
  }

  function program(gl, vs, fs, varyings) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    if (varyings) gl.transformFeedbackVaryings(p, varyings, gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  class SmokeOrbRenderer {
    constructor(canvas, { renderScale = 1, particles = 24000 } = {}) {
      this.canvas = canvas;
      this.renderScale = renderScale;
      this.count = Math.max(2000, Math.min(200000, particles | 0));
      const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
      if (!gl) throw new Error('WebGL2 is not available');
      this.gl = gl;
      this.float = !!gl.getExtension('EXT_color_buffer_float');

      this.sim = program(gl, SIM_VS, SIM_FS, ['oPos', 'oVel', 'oMeta']);
      this.pts = program(gl, PT_VS, PT_FS);
      this.fade = program(gl, QUAD_VS, FADE_FS);
      this.comp = program(gl, QUAD_VS, COMP_FS);

      // Particle buffers (ping-pong). Transform feedback writes pos/vel/meta
      // tightly packed (10 floats); we use the same layout for reading.
      const N = this.count;
      const init = new Float32Array(N * 10);
      for (let i = 0; i < N; i++) {
        const o = i * 10;
        init[o + 6] = -Math.random(); // life <= 0 -> spawns on the first frame
        init[o + 7] = Math.random(); // seed
        init[o + 8] = 0; // maxLife
        init[o + 9] = Math.random() < 0.12 ? 1 : 0; // 12% inner dust
      }
      this.bufs = [gl.createBuffer(), gl.createBuffer()];
      for (const b of this.bufs) {
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, init, gl.DYNAMIC_COPY);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      const stride = 10 * 4;
      const attr = (prog, name, size, offset) => {
        const loc = gl.getAttribLocation(prog, name);
        if (loc < 0) return;
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      };
      this.simVao = this.bufs.map((b) => {
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        attr(this.sim.p, 'aPos', 3, 0);
        attr(this.sim.p, 'aVel', 3, 12);
        attr(this.sim.p, 'aMeta', 4, 24);
        return vao;
      });
      this.drawVao = this.bufs.map((b) => {
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        attr(this.pts.p, 'aPos', 3, 0);
        attr(this.pts.p, 'aMeta', 4, 24);
        return vao;
      });
      this.quadVao = gl.createVertexArray();
      gl.bindVertexArray(this.quadVao);
      const qb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, qb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      for (const prog of [this.fade.p, this.comp.p]) {
        const loc = gl.getAttribLocation(prog, 'aQuad');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      }
      gl.bindVertexArray(null);
      this.tf = gl.createTransformFeedback();
      this.read = 0;

      this.armP = new Float32Array(16);
      this.armR = new Float32Array(8);
      this.armOn = new Float32Array(2);
      this.armMode = new Float32Array(2);
      this.lastT = null;
      this.trails = null;
      this.resize();
    }

    resize() {
      const gl = this.gl;
      const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.renderScale;
      const w = Math.max(1, Math.round(window.innerWidth * dpr));
      const h = Math.max(1, Math.round(window.innerHeight * dpr));
      this.sc = w / window.innerWidth;
      if (this.canvas.width === w && this.canvas.height === h && this.trails) return;
      this.canvas.width = w;
      this.canvas.height = h;
      if (this.trails) for (const t of this.trails) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
      const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
      const fmt = this.float ? gl.RGBA16F : gl.RGBA8;
      this.trails = [0, 1].map(() => {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, levels, fmt, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return { tex, fb };
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.trailIdx = 0;
    }

    render(s) {
      const gl = this.gl;
      const dt = this.lastT === null ? 1 / 60 : Math.min(0.05, Math.max(0.001, s.t - this.lastT));
      this.lastT = s.t;
      const W = this.canvas.width;
      const H = this.canvas.height;
      const sc = this.sc;

      for (let i = 0; i < 2; i++) {
        const g = s.arms[i];
        this.armOn[i] = g ? g.on : 0;
        this.armMode[i] = g && g.mode === 'explain' ? 1 : 0;
        for (let k = 0; k < 4; k++) {
          this.armP[i * 8 + k * 2] = g ? g.pts[k].x : 0;
          this.armP[i * 8 + k * 2 + 1] = g ? g.pts[k].y : 0;
          this.armR[i * 4 + k] = g ? g.radii[k] : 0;
        }
      }

      // 1. simulate
      const su = this.sim.u;
      gl.useProgram(this.sim.p);
      gl.uniform1f(su.uTime, s.t);
      gl.uniform1f(su.uDt, dt);
      gl.uniform3f(su.uCenter, s.pos.x, s.pos.y, 0);
      gl.uniform2f(su.uCenterVel, s.vel.x, s.vel.y);
      gl.uniform1f(su.uR, s.r);
      gl.uniform1f(su.uAmp, s.amp);
      gl.uniform1f(su.uListen, s.listen);
      gl.uniform1f(su.uThink, s.think);
      gl.uniform1f(su.uFlow, 0.55);
      gl.uniform2fv(su.uArmP, this.armP);
      gl.uniform4fv(su.uArmR, this.armR);
      gl.uniform1fv(su.uArmOn, this.armOn);
      gl.uniform1fv(su.uArmMode, this.armMode);
      const write = 1 - this.read;
      gl.bindVertexArray(this.simVao[this.read]);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.tf);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.bufs[write]);
      gl.enable(gl.RASTERIZER_DISCARD);
      gl.beginTransformFeedback(gl.POINTS);
      gl.drawArrays(gl.POINTS, 0, this.count);
      gl.endTransformFeedback();
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
      this.read = write;

      // 2. fade previous trails into the other buffer
      const src = this.trails[this.trailIdx];
      const dst = this.trails[1 - this.trailIdx];
      this.trailIdx = 1 - this.trailIdx;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
      gl.viewport(0, 0, W, H);
      gl.disable(gl.BLEND);
      gl.useProgram(this.fade.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(this.fade.u.uPrev, 0);
      const prev = this.prevCenter || s.pos;
      let sx = (s.pos.x - prev.x) / window.innerWidth;
      let sy = -(s.pos.y - prev.y) / window.innerHeight;
      if (Math.abs(sx) > 0.25 || Math.abs(sy) > 0.25) { sx = 0; sy = 0; } // teleport: don't smear
      this.prevCenter = { x: s.pos.x, y: s.pos.y };
      gl.uniform2f(this.fade.u.uShift, sx, sy);
      const speed = Math.hypot(s.vel.x, s.vel.y);
      const keep = 0.86 - 0.18 * Math.min(1, speed / (s.r * 12));
      gl.uniform1f(this.fade.u.uKeep, Math.pow(keep, dt * 60));
      gl.uniform1f(this.fade.u.uFloor, this.float ? 0.0005 : 1 / 255);
      gl.bindVertexArray(this.quadVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 3. particles, additive
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      const pu = this.pts.u;
      gl.useProgram(this.pts.p);
      gl.uniform2f(pu.uView, window.innerWidth, window.innerHeight);
      gl.uniform1f(pu.uPx, sc);
      gl.uniform1f(pu.uSize, Math.max(1.6, s.r * 0.05));
      gl.uniform1f(pu.uR, s.r);
      gl.uniform1f(pu.uTime, s.t);
      gl.uniform3f(pu.uTint, s.tint[0], s.tint[1], s.tint[2]);
      gl.uniform1f(pu.uAmp, s.amp);
      gl.uniform1f(pu.uGlow, s.glow);
      gl.uniform1f(pu.uBright, 24000 / this.count);
      gl.bindVertexArray(this.drawVao[this.read]);
      gl.drawArrays(gl.POINTS, 0, this.count);
      gl.disable(gl.BLEND);

      // 4. bloom mips + composite to the transparent window
      gl.bindTexture(gl.TEXTURE_2D, dst.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const cu = this.comp.u;
      gl.useProgram(this.comp.p);
      gl.uniform1i(cu.uTex, 0);
      gl.uniform2f(cu.uCenterPx, s.pos.x * sc, H - s.pos.y * sc);
      gl.uniform1f(cu.uRPx, s.r * sc);
      gl.uniform3f(cu.uTint, s.tint[0], s.tint[1], s.tint[2]);
      gl.uniform1f(cu.uHalo, s.halo);
      gl.uniform1f(cu.uAura, 0.78);
      gl.uniform1f(cu.uLight, s.light || 0);
      gl.uniform1f(cu.uTime, s.t);
      gl.bindVertexArray(this.quadVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    }
  }

  root.SmokeOrbRenderer = SmokeOrbRenderer;
})(window);
