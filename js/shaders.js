/* LUMEN — GLSL sources
 *
 * Particle state lives in two RGBA32F textures (position+seed, velocity+energy)
 * that ping-pong every frame. One fragment = one particle.
 */
(function (L) {
  'use strict';

  const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

  const COMMON = `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// Staggered per-particle transition progress (0 -> 1) after a shape change.
float formOf(float seed, float st) {
  float delay = seed * 0.9;
  return smoothstep(0.0, 1.0, clamp((st - delay) / 1.5, 0.0, 1.0));
}
vec2 videoUV(ivec2 ij, float n) {
  vec2 f = vec2(ij);
  return (f + vec2(hash12(f), hash12(f + 17.31))) / n;
}
`;

  // Ashima / Stefan Gustavson simplex noise with analytic gradient.
  const NOISE = `
vec4 permute(vec4 x) { return mod(((x * 34.0) + 10.0) * x, 289.0); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v, out vec3 grad) {
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
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
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
  vec4 t = m2 * m * pdotx;
  grad = -8.0 * (t.x * x0 + t.y * x1 + t.z * x2 + t.w * x3);
  grad += m4.x * p0 + m4.y * p1 + m4.z * p2 + m4.w * p3;
  grad *= 42.0;
  return 42.0 * dot(m4, pdotx);
}
// Divergence-free flow built from three noise potentials; g1 is also returned
// so callers can add a (non divergence-free) clustering term.
vec3 curlNoise(vec3 p, out vec3 g1) {
  vec3 g2, g3;
  snoise(p, g1);
  snoise(p + vec3(31.416, -47.853, 12.679), g2);
  snoise(p + vec3(-233.145, -113.408, -185.31), g3);
  return vec3(g3.y - g2.z, g1.z - g3.x, g2.x - g1.y);
}
`;

  // Fullscreen triangle.
  const fullVS = HEADER + `
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

  // ---------------------------------------------------------------- simulation
  const simFS = HEADER + COMMON + NOISE + `
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform sampler2D uTarget;
uniform sampler2D uVideo;
uniform float uNf;
uniform float uTime;
uniform float uDt;
uniform float uShapeTime;
uniform int uMode;          // 0 target, 1 nebula flow, 2 lorenz flow, 3 video
uniform int uAnim;          // 0 none, 1 butterfly, 2 heartbeat
uniform float uPulse;       // heartbeat envelope
uniform float uTurb;
uniform float uSpring;
uniform float uBass;
uniform float uVideoAspect;
uniform vec3 uRayO;
uniform vec3 uRayD;
uniform vec3 uPointer;
uniform vec3 uPointerVel;
uniform float uHold;
uniform vec4 uShock[8];     // xyz centre, w start time
uniform vec4 uShockP[8];    // strength, speed, width, life

layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;

vec3 rotX(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
}

vec3 animTarget(vec3 t) {
  if (uAnim == 1) {
    // butterfly: fold both wings around the body (y) axis, then tilt the insect
    float ph = uTime * 4.4;
    float ax = abs(t.x);
    float a = 0.30 + 0.62 * sin(ph - ax * 0.55);
    vec3 q = vec3(sign(t.x) * ax * cos(a), t.y, ax * sin(a) + t.z);
    q = rotX(q, -1.1);
    q.y += 0.14 * sin(ph + 2.4) - 0.15;
    return q;
  }
  if (uAnim == 2) {
    return t * (1.0 + 0.12 * uPulse);
  }
  return t;
}

vec3 videoTarget(ivec2 ij) {
  vec2 uv = videoUV(ij, uNf);
  vec3 c = texture(uVideo, uv).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  float H = 3.5;
  float W = H * uVideoAspect;
  return vec3((0.5 - uv.x) * W, (0.5 - uv.y) * H, (l - 0.45) * 1.1);
}

vec3 lorenzVel(vec3 w) {
  const float S = 11.0;
  vec3 q = vec3(w.x * S, w.z * S, w.y * S + 24.0);
  vec3 dq = vec3(10.0 * (q.y - q.x), q.x * (28.0 - q.z) - q.y, q.x * q.y - (8.0 / 3.0) * q.z);
  return vec3(dq.x, dq.z, dq.y) / S * 0.3;
}

void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(uPos, ij, 0);
  vec4 V = texelFetch(uVel, ij, 0);
  vec3 p = P.xyz;
  vec3 v = V.xyz;
  float seed = P.w;
  float dt = uDt;
  float form = formOf(seed, uShapeTime);
  float energy = V.w * exp(-dt * 2.2);
  vec3 acc = vec3(0.0);
  float damp = 1.0;
  vec3 advect = vec3(0.0);
  vec3 g1;

  if (uMode == 0 || uMode == 3) {
    vec3 T = uMode == 0 ? animTarget(texelFetch(uTarget, ij, 0).xyz) : videoTarget(ij);
    T *= 1.0 + uBass * 0.06;
    float k = uSpring * (1.0 - uHold * 0.92);
    acc += (T - p) * k * form;
    damp = mix(1.5, 4.6, form);
    acc += curlNoise(p * 0.7 + vec3(0.0, uTime * 0.06, 0.0), g1) * uTurb * mix(2.2, 0.06, form);
  } else if (uMode == 1) {
    vec3 c = curlNoise(p * 0.34 + vec3(uTime * 0.012, 0.0, uTime * 0.025), g1);
    vec3 desired = (c * 0.5 + g1 * 0.22) * uTurb;
    acc += (desired - v) * mix(0.6, 1.6, form);
    float r = length(p);
    acc -= p / max(r, 1e-3) * smoothstep(2.0, 3.8, r) * 2.5;
    damp = 0.25;
  } else {
    // Advect exactly along the Lorenz flow (RK2); v only carries perturbations
    // from the pointer and shockwaves, which decay back onto the attractor.
    vec3 f1 = lorenzVel(p);
    f1 *= min(1.0, 8.0 / max(length(f1), 1e-4));
    vec3 f2 = lorenzVel(p + f1 * dt * 0.5);
    f2 *= min(1.0, 8.0 / max(length(f2), 1e-4));
    advect = f2 * form;
    acc += curlNoise(p * 0.9 + uTime * 0.1, g1) * uTurb * mix(2.4, 0.05, form);
    damp = mix(1.0, 2.2, form);
  }

  // --- pointer: wake + swirl around the view ray
  vec3 rel = p - uRayO;
  vec3 closest = uRayO + uRayD * dot(rel, uRayD);
  vec3 perp = p - closest;
  float dr = length(perp);
  float fall = exp(-dr * dr / 0.22);
  float pv = length(uPointerVel);
  acc += uPointerVel * fall * 2.2;
  acc += cross(uRayD, perp / (dr + 1e-3)) * pv * fall * 1.4;
  energy += pv * fall * dt * 0.08;

  // --- black hole while the pointer is held
  if (uHold > 0.0) {
    vec3 toC = uPointer - p;
    float dc = length(toC) + 0.04;
    vec3 dir = toC / dc;
    float g = uHold * 9.0 / (0.25 + dc * dc);
    acc += dir * g;
    acc += cross(uRayD, dir) * g * 0.9;
    energy += uHold * dt * 1.5 / (0.15 + dc * dc * 3.0);
  }

  // --- shockwaves: expanding spherical shells
  for (int i = 0; i < 8; i++) {
    vec4 s = uShock[i];
    vec4 sp = uShockP[i];
    float age = uTime - s.w;
    if (age < 0.0 || age > sp.w) continue;
    vec3 d = p - s.xyz;
    float dist = length(d) + 1e-4;
    float R = age * sp.y;
    float x = (dist - R) / sp.z;
    float f = exp(-x * x) * (1.0 - age / sp.w) * sp.x;
    acc += d / dist * f;
    energy += f * dt * 0.12;
  }

  v += acc * dt;
  v *= exp(-damp * dt);
  float spd = length(v);
  if (spd > 30.0) v *= 30.0 / spd;
  p += (v + advect) * dt;

  if (any(isnan(p)) || any(isnan(v)) || length(p) > 80.0) {
    vec2 f = vec2(ij);
    p = (vec3(hash12(f), hash12(f + 3.1), hash12(f + 7.7)) - 0.5) * 4.0;
    v = vec3(0.0);
    energy = 0.0;
  }

  oPos = vec4(p, seed);
  oVel = vec4(v, min(energy, 3.0));
}
`;

  // ---------------------------------------------------------------- particles
  const particleVS = HEADER + COMMON + `
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform sampler2D uColPrev;
uniform sampler2D uColCur;
uniform sampler2D uVideo;
uniform int uSrcPrev;
uniform int uSrcCur;
uniform int uN;
uniform mat4 uProj;
uniform mat4 uView;
uniform float uTime;
uniform float uShapeTime;
uniform float uPointScale;
uniform float uIntensity;
uniform float uHigh;
out vec3 vColor;

vec3 grad4(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  t = fract(t) * 4.0;
  if (t < 1.0) return mix(a, b, t);
  if (t < 2.0) return mix(b, c, t - 1.0);
  if (t < 3.0) return mix(c, d, t - 2.0);
  return mix(d, a, t - 3.0);
}

vec4 colorFrom(int src, vec4 tc, vec3 p, float seed, ivec2 ij) {
  if (src == 0) return vec4(tc.rgb, tc.a * 2.0);
  if (src == 1) {
    float t = length(p) * 0.16 + p.y * 0.07 + seed * 0.22 + uTime * 0.004;
    vec3 c = grad4(t, vec3(0.10, 0.22, 1.0), vec3(0.55, 0.18, 1.0), vec3(1.0, 0.25, 0.55), vec3(0.10, 0.85, 0.85));
    return vec4(c, 0.9);
  }
  if (src == 2) {
    float t = clamp(p.x * 0.3 + 0.5, 0.0, 1.0);
    vec3 c = mix(vec3(1.0, 0.38, 0.12), vec3(0.15, 0.55, 1.0), smoothstep(0.25, 0.75, t));
    c = mix(c, vec3(1.0, 0.25, 0.75), smoothstep(1.2, 2.2, p.y) * 0.8);
    return vec4(c, 1.0);
  }
  vec3 vc = texture(uVideo, videoUV(ij, float(uN))).rgb;
  return vec4(pow(vc, vec3(2.2)), 1.25);
}

void main() {
  ivec2 ij = ivec2(gl_VertexID % uN, gl_VertexID / uN);
  vec4 P = texelFetch(uPos, ij, 0);
  vec4 V = texelFetch(uVel, ij, 0);
  float seed = P.w;
  float form = formOf(seed, uShapeTime);

  vec4 c0 = colorFrom(uSrcPrev, texelFetch(uColPrev, ij, 0), P.xyz, seed, ij);
  vec4 c1 = colorFrom(uSrcCur, texelFetch(uColCur, ij, 0), P.xyz, seed, ij);
  vec4 c = mix(c0, c1, form);
  vec3 col = c.rgb * c.a;

  float speed = length(V.xyz);
  float heat = smoothstep(1.5, 9.0, speed);
  col = mix(col, vec3(1.0, 0.78, 0.6) * (0.5 + c.a), heat * 0.55);
  col += vec3(1.0, 0.72, 0.45) * V.w * 1.4;

  float star = step(0.9965, fract(seed * 91.713));
  float tw = 0.78 + 0.22 * sin(uTime * (1.3 + seed * 4.0) + seed * 60.0);
  tw += uHigh * step(0.9, fract(seed * 37.1)) * 3.0;

  vec4 view = uView * vec4(P.xyz, 1.0);
  gl_Position = uProj * view;
  float dist = max(-view.z, 0.05);
  float size = uPointScale * (0.55 + fract(seed * 13.7) * 0.9) * (1.0 + star * 1.6) / dist;
  float s = clamp(size, 1.35, 64.0);
  float fade = min(1.0, (size / s) * (size / s));
  gl_PointSize = s;
  vColor = col * tw * uIntensity * fade * (1.0 + heat * 0.8 + star * 2.5);
  if (-view.z < 0.15) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

  const particleFS = HEADER + `
in vec3 vColor;
out vec4 o;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  o = vec4(vColor * exp(-r2 * 3.6), 1.0);
}
`;

  // ---------------------------------------------------------------- background stars
  const starsVS = HEADER + `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aCol;
uniform mat4 uProj;
uniform mat4 uView;
uniform float uTime;
uniform float uIntensity;
uniform float uScale;
out vec3 vColor;
void main() {
  vec3 v = mat3(uView) * aPos;
  gl_Position = uProj * vec4(v, 1.0);
  float ph = fract(sin(dot(aPos, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float tw = 0.55 + 0.45 * sin(uTime * (0.6 + ph * 2.5) + ph * 40.0);
  gl_PointSize = aCol.a * uScale;
  vColor = aCol.rgb * uIntensity * tw;
}
`;

  // ---------------------------------------------------------------- post
  const fadeFS = HEADER + `
out vec4 o;
void main() { o = vec4(0.0); }
`;

  const downFS = HEADER + `
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform int uFirst;
uniform float uThreshold;
out vec4 o;
void main() {
  vec3 s = texture(uSrc, vUv).rgb * 4.0;
  s += texture(uSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
  s += texture(uSrc, vUv + vec2( 1.0, -1.0) * uTexel).rgb;
  s += texture(uSrc, vUv + vec2(-1.0,  1.0) * uTexel).rgb;
  s += texture(uSrc, vUv + vec2( 1.0,  1.0) * uTexel).rgb;
  s /= 8.0;
  if (uFirst == 1) {
    float br = max(s.r, max(s.g, s.b));
    float knee = uThreshold * 0.6;
    float rq = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
    rq = rq * rq / (4.0 * knee + 1e-4);
    s *= max(rq, br - uThreshold) / max(br, 1e-4);
  }
  o = vec4(s, 1.0);
}
`;

  const upFS = HEADER + `
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uWeight;
out vec4 o;
void main() {
  vec2 h = uTexel;
  vec3 s = texture(uSrc, vUv + vec2(-2.0 * h.x, 0.0)).rgb;
  s += texture(uSrc, vUv + vec2(-h.x, h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(0.0, 2.0 * h.y)).rgb;
  s += texture(uSrc, vUv + vec2(h.x, h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(2.0 * h.x, 0.0)).rgb;
  s += texture(uSrc, vUv + vec2(h.x, -h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(0.0, -2.0 * h.y)).rgb;
  s += texture(uSrc, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  o = vec4(s / 12.0 * uWeight, 1.0);
}
`;

  const compositeFS = HEADER + `
in vec2 vUv;
uniform sampler2D uHdr;
uniform sampler2D uBloom;
uniform float uBloomStr;
uniform float uExposure;
uniform float uTime;
uniform vec2 uRes;
uniform float uFlash;
out vec4 o;

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 uv = vUv;
  vec2 dc = uv - 0.5;
  float ca = 0.006 * dot(dc, dc);
  vec3 hdr;
  hdr.r = texture(uHdr, uv - dc * ca * 2.0).r;
  hdr.g = texture(uHdr, uv).g;
  hdr.b = texture(uHdr, uv + dc * ca * 2.0).b;
  vec3 bloom = texture(uBloom, uv).rgb;
  vec3 col = hdr + bloom * uBloomStr;

  float r = length(dc * vec2(uRes.x / uRes.y, 1.0));
  vec3 bg = mix(vec3(0.012, 0.010, 0.030), vec3(0.0015, 0.0015, 0.004), smoothstep(0.0, 1.0, r));
  col += bg + vec3(0.9, 0.8, 1.0) * uFlash;

  col = aces(col * uExposure);
  col *= 1.0 - 0.45 * smoothstep(0.45, 1.25, r);
  col = pow(col, vec3(1.0 / 2.2));
  col += (hash(gl_FragCoord.xy + fract(uTime * 7.13) * 91.0) - 0.5) * 0.025;
  o = vec4(col, 1.0);
}
`;

  L.shaders = { fullVS, simFS, particleVS, particleFS, starsVS, fadeFS, downFS, upFS, compositeFS };
})(window.LUMEN = window.LUMEN || {});
