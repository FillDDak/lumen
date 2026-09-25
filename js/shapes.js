/* LUMEN — shape generators
 *
 * Every generator fills `n` particles with a target position (xyz) and a colour
 * (rgb + brightness in alpha, where 128 == 1.0). Colours are in linear space.
 */
// The module is a named function so it can also be stringified into a Web
// Worker (see L.ShapeWorker below) and generate shapes off the main thread.
function lumenShapes(L) {
  'use strict';

  const TAU = Math.PI * 2;
  const R = Math.random;

  function gauss() {
    let u = 0;
    while (u === 0) u = R();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * R());
  }
  const mix = (a, b, t) => a + (b - a) * t;
  const mix3 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
  const smooth = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  function norm3(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }
  function unitVec() {
    const z = R() * 2 - 1;
    const a = R() * TAU;
    const s = Math.sqrt(1 - z * z);
    return [s * Math.cos(a), z, s * Math.sin(a)];
  }

  function alloc(n) {
    return { pos: new Float32Array(n * 4), col: new Uint8ClampedArray(n * 4) };
  }
  function put(S, i, x, y, z, c, a) {
    const k = i * 4;
    S.pos[k] = x; S.pos[k + 1] = y; S.pos[k + 2] = z; S.pos[k + 3] = 1;
    S.col[k] = c[0] * 255; S.col[k + 1] = c[1] * 255; S.col[k + 2] = c[2] * 255;
    S.col[k + 3] = a * 128;
  }

  // ------------------------------------------------------------------ nebula
  function nebula(n) {
    const S = alloc(n);
    for (let i = 0; i < n; i++) {
      const v = unitVec();
      const r = Math.cbrt(R()) * 2.6;
      put(S, i, v[0] * r, v[1] * r * 0.8, v[2] * r, [1, 1, 1], 1);
    }
    return S;
  }

  // ------------------------------------------------------------------ orb (intro screen, same look as the favicon)
  function orb(n) {
    const S = alloc(n);
    const teal = [0.1, 0.85, 0.85], violet = [0.55, 0.18, 1.0], pink = [1.0, 0.25, 0.55], blue = [0.1, 0.22, 1.0];
    const lx = -0.55, ly = 0.6, lz = 0.58; // teal side faces upper-left
    const Rb = 1.75;
    for (let i = 0; i < n; i++) {
      const d = unitVec();
      const surface = R() < 0.7;
      const r = surface ? Rb * (1 + (R() - 0.5) * 0.02) : Rb * Math.cbrt(R());
      const k = 0.5 + 0.5 * (d[0] * lx + d[1] * ly + d[2] * lz);
      let c = k > 0.5 ? mix3(violet, teal, (k - 0.5) * 2) : mix3(pink, violet, k * 2);
      const band = 0.5 + 0.5 * Math.sin(d[1] * 7 + Math.sin(d[0] * 4 + d[2] * 3) * 1.6);
      c = mix3(c, blue, 0.18 * band);
      put(S, i, d[0] * r, d[1] * r, d[2] * r, c, surface ? 0.55 + 0.45 * band : 0.35);
    }
    return S;
  }

  // ------------------------------------------------------------------ galaxy
  function galaxy(n) {
    const S = alloc(n);
    const arms = 2;
    const warm = [1.0, 0.72, 0.42], cream = [1.0, 0.9, 0.75], blue = [0.42, 0.62, 1.0], ice = [0.75, 0.85, 1.0];
    for (let i = 0; i < n; i++) {
      const u = R();
      if (u < 0.17) {
        // central bulge
        const v = unitVec();
        const r = Math.abs(gauss()) * 0.33;
        put(S, i, v[0] * r, v[1] * r * 0.62, v[2] * r, mix3(warm, cream, R()), 1.25);
      } else if (u < 0.92) {
        // spiral arms
        const rad = 0.2 + Math.pow(R(), 1.35) * 2.75;
        const arm = Math.floor(R() * arms);
        const scatter = gauss() * (0.2 + 0.12 / (rad + 0.15));
        const ang = (arm / arms) * TAU + rad * 2.15 + scatter;
        const rr = rad + gauss() * 0.06;
        const y = gauss() * 0.045 * (1 + 1.5 * Math.exp(-rad * 1.8));
        const t = smooth(0.15, 1.6, rad);
        let c = mix3(warm, blue, t);
        let a = 0.75;
        if (Math.abs(scatter) < 0.08 && rad > 0.7 && R() < 0.12) { c = [1.0, 0.32, 0.55]; a = 1.5; }
        else if (R() < 0.08) { c = ice; a = 1.2; }
        put(S, i, Math.cos(ang) * rr, y, Math.sin(ang) * rr, c, a);
      } else {
        // diffuse disk + halo
        const rad = Math.sqrt(R()) * 3.4;
        const ang = R() * TAU;
        put(S, i, Math.cos(ang) * rad, gauss() * 0.22, Math.sin(ang) * rad, [0.45, 0.5, 0.9], 0.3);
      }
    }
    return S;
  }

  // ------------------------------------------------------------------ ringed planet
  function planet(n) {
    const S = alloc(n);
    const sun = (() => { const v = [-0.75, 0.35, 0.6]; const l = Math.hypot(...v); return v.map((x) => x / l); })();
    const tilt = 0.42, ct = Math.cos(tilt), st = Math.sin(tilt);
    const tiltP = (x, y, z) => [x * ct - y * st, x * st + y * ct, z];
    const sand = [1.0, 0.8, 0.52], rust = [0.78, 0.44, 0.24], pale = [0.95, 0.92, 0.85];
    const ringDensity = (r) => {
      let d = 0.55 + 0.45 * Math.pow(Math.sin(r * 47.0), 2);
      d *= 1 - 0.95 * Math.exp(-Math.pow((r - 1.98) / 0.045, 2)); // Cassini division
      d *= 1 - 0.6 * Math.exp(-Math.pow((r - 2.32) / 0.02, 2));
      d *= smooth(1.32, 1.45, r) * (1 - smooth(2.45, 2.6, r));
      return d;
    };
    for (let i = 0; i < n; i++) {
      const u = R();
      if (u < 0.42) {
        const v = unitVec();
        const Rp = 1.0 + Math.abs(gauss()) * 0.006;
        const lat = v[1];
        const band = 0.5 + 0.5 * Math.sin(lat * 17 + Math.sin(lat * 6 + v[0] * 1.5) * 1.3);
        let c = mix3(rust, sand, band);
        if (Math.abs(lat + 0.3) < 0.06 && Math.abs(v[0] - 0.4) < 0.18) c = [1.0, 0.45, 0.3];
        const lam = Math.max(0, v[0] * sun[0] + v[1] * sun[1] + v[2] * sun[2]);
        const light = 0.05 + 0.95 * Math.pow(lam, 0.8);
        const p = tiltP(v[0] * Rp, v[1] * Rp, v[2] * Rp);
        put(S, i, p[0], p[1], p[2], c, 1.25 * light);
      } else if (u < 0.47) {
        // atmosphere rim
        const v = unitVec();
        const r = 1.0 + Math.abs(gauss()) * 0.05;
        const lam = Math.max(0, v[0] * sun[0] + v[1] * sun[1] + v[2] * sun[2]);
        const p = tiltP(v[0] * r, v[1] * r, v[2] * r);
        put(S, i, p[0], p[1], p[2], [0.45, 0.65, 1.0], 0.12 + 0.5 * lam);
      } else if (u < 0.97) {
        // rings (rejection sampled for gaps)
        let r;
        do { r = 1.3 + R() * 1.35; } while (R() > ringDensity(r));
        const ang = R() * TAU;
        const x = Math.cos(ang) * r, z = Math.sin(ang) * r, y = gauss() * 0.006;
        const shade = mix3(pale, [0.85, 0.72, 0.55], 0.5 + 0.5 * Math.sin(r * 11));
        // planet shadow on the rings
        const along = x * sun[0] + z * sun[2];
        const px = x - sun[0] * along, pz = z - sun[2] * along;
        const inShadow = along < 0 && Math.hypot(px, pz) < 1.0;
        const p = tiltP(x, y, z);
        put(S, i, p[0], p[1], p[2], shade, inShadow ? 0.06 : 0.62);
      } else {
        // small moon
        const v = unitVec();
        const r = 0.13;
        const lam = Math.max(0, v[0] * sun[0] + v[1] * sun[1] + v[2] * sun[2]);
        put(S, i, 2.9 + v[0] * r, 0.9 + v[1] * r, -1.1 + v[2] * r, [0.85, 0.88, 0.95], 0.1 + 1.2 * lam);
      }
    }
    return S;
  }

  // ------------------------------------------------------------------ butterfly (Fay's curve, filled)
  function butterflyCurve(t) {
    const r = Math.exp(Math.sin(t)) - 2 * Math.cos(4 * t) + Math.pow(Math.sin((2 * t - Math.PI) / 24), 5);
    return [Math.sin(t) * r, Math.cos(t) * r];
  }
  function butterfly(n) {
    // In Fay's curve the mirror axis is y: y is the wingspan, x runs along the body.
    const S = alloc(n);
    const TMAX = 12 * Math.PI;
    let minX = 1e9, maxX = -1e9, maxY = 0;
    for (let k = 0; k < 6000; k++) {
      const [x, y] = butterflyCurve((k / 6000) * TMAX);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); maxY = Math.max(maxY, Math.abs(y));
    }
    const sc = 4.2 / (maxY * 2);
    const cb = (maxX + minX) / 2;
    const deep = [0.28, 0.12, 1.0], azure = [0.1, 0.75, 1.0], ember = [1.0, 0.5, 0.12];
    for (let i = 0; i < n; i++) {
      const u = R();
      if (u < 0.95) {
        const [bx, by] = butterflyCurve(R() * TMAX);
        const outline = u < 0.3;
        const s = outline ? 1 + gauss() * 0.006 : Math.sqrt(R());
        const mirror = R() < 0.5 ? -1 : 1;
        const x = Math.abs(by * s) * mirror * sc;
        const y = (bx * s - cb) * sc;
        const d = Math.min(1, Math.hypot(bx, by) * s / 4.2);
        let c = mix3(deep, azure, smooth(0.15, 0.85, d));
        let a = 0.7;
        if (outline) { c = mix3(azure, [0.9, 0.97, 1.0], 0.6); a = 1.0; }
        else if (d > 0.55 && bx * s > 1.2 && R() < 0.14) { c = ember; a = 1.2; }
        put(S, i, x, y, gauss() * 0.012, c, a);
      } else if (u < 0.985) {
        // body
        const t = R();
        const y = (mix(-1.7, 2.3, t) - cb) * sc;
        const w = 0.055 * Math.sin(t * Math.PI) + 0.014;
        const v = unitVec();
        put(S, i, v[0] * w, y + v[1] * 0.02, v[2] * w, [1.0, 0.75, 0.45], 1.1);
      } else {
        // antennae
        const t = R();
        const side = R() < 0.5 ? -1 : 1;
        const top = (2.3 - cb) * sc;
        put(S, i, side * t * 0.34, top + t * 0.5 - t * t * 0.12, 0, [1.0, 0.8, 0.55], 0.9);
      }
    }
    return S;
  }

  // ------------------------------------------------------------------ Lorenz (static samples; the sim flows them live)
  function lorenz(n) {
    const S = alloc(n);
    let x = 0.1, y = 0, z = 0;
    const dt = 0.004;
    for (let k = 0; k < 2000; k++) {
      const dx = 10 * (y - x), dy = x * (28 - z) - y, dz = x * y - (8 / 3) * z;
      x += dx * dt; y += dy * dt; z += dz * dt;
    }
    for (let i = 0; i < n; i++) {
      for (let s = 0; s < 3; s++) {
        const dx = 10 * (y - x), dy = x * (28 - z) - y, dz = x * y - (8 / 3) * z;
        x += dx * dt; y += dy * dt; z += dz * dt;
      }
      put(S, i, x / 11, (z - 24) / 11, y / 11, [1, 1, 1], 1);
    }
    return S;
  }

  // ------------------------------------------------------------------ DNA double helix
  function dna(n) {
    const S = alloc(n);
    const H = 4.4, turns = 2.6, Rh = 0.62, rungs = 34;
    const strandC = [[0.25, 0.65, 1.0], [1.0, 0.35, 0.7]];
    const bases = [[0.35, 1.0, 0.6], [1.0, 0.82, 0.25], [0.6, 0.45, 1.0], [1.0, 0.45, 0.25]];
    const phase = 2.2;
    for (let i = 0; i < n; i++) {
      const u = R();
      if (u < 0.6) {
        const s = R();
        const k = R() < 0.5 ? 0 : 1;
        const ang = s * turns * TAU + k * phase;
        const y = (s - 0.5) * H;
        const v = unitVec();
        const tr = 0.055 * Math.sqrt(R());
        put(S, i, Math.cos(ang) * Rh + v[0] * tr, y + v[1] * tr, Math.sin(ang) * Rh + v[2] * tr, strandC[k], 0.95);
      } else if (u < 0.93) {
        const j = Math.floor(R() * rungs);
        const s = (j + 0.5) / rungs;
        const a0 = s * turns * TAU, a1 = a0 + phase;
        const y = (s - 0.5) * H;
        const t = R();
        const x = mix(Math.cos(a0) * Rh, Math.cos(a1) * Rh, t);
        const z = mix(Math.sin(a0) * Rh, Math.sin(a1) * Rh, t);
        const pair = j % 4;
        const c = t < 0.5 ? bases[pair] : bases[(pair + 2) % 4];
        put(S, i, x + gauss() * 0.012, y + gauss() * 0.012, z + gauss() * 0.012, c, 0.7);
      } else {
        const ang = R() * TAU, rad = 0.9 + R() * 1.2;
        put(S, i, Math.cos(ang) * rad, (R() - 0.5) * H * 1.2, Math.sin(ang) * rad, [0.4, 0.8, 1.0], 0.25);
      }
    }
    return S;
  }

  // ------------------------------------------------------------------ torus knot
  function knot(n) {
    const S = alloc(n);
    const p = 3, q = 5, sc = 0.62, tube = 0.2;
    const curve = (t) => {
      const r = Math.cos(q * t) + 2.2;
      return [r * Math.cos(p * t) * sc, -Math.sin(q * t) * sc * 1.1, r * Math.sin(p * t) * sc];
    };
    const stops = [[0.1, 0.5, 1.0], [0.55, 0.2, 1.0], [1.0, 0.25, 0.6], [1.0, 0.6, 0.15], [0.1, 0.9, 0.8]];
    const palette = (t) => {
      t = (t % 1) * stops.length;
      const k = Math.floor(t);
      return mix3(stops[k], stops[(k + 1) % stops.length], t - k);
    };
    for (let i = 0; i < n; i++) {
      const t = R() * TAU;
      const c = curve(t);
      const c2 = curve(t + 0.001);
      const T = norm3([c2[0] - c[0], c2[1] - c[1], c2[2] - c[2]]);
      let N = [-T[2], 0, T[0]]; // T x (0,1,0)
      if (Math.hypot(N[0], N[2]) < 1e-3) N = [1, 0, 0];
      N = norm3(N);
      const B = [T[1] * N[2] - T[2] * N[1], T[2] * N[0] - T[0] * N[2], T[0] * N[1] - T[1] * N[0]];
      const a = R() * TAU;
      const surf = R() < 0.8;
      const rr = tube * (surf ? 1 + gauss() * 0.03 : Math.sqrt(R()) * 0.9);
      const ca = Math.cos(a), sa = Math.sin(a);
      const x = c[0] + (N[0] * ca + B[0] * sa) * rr;
      const y = c[1] + (N[1] * ca + B[1] * sa) * rr;
      const z = c[2] + (N[2] * ca + B[2] * sa) * rr;
      const light = 0.55 + 0.45 * Math.max(0, N[1] * ca + B[1] * sa);
      put(S, i, x, y, z, palette(t / TAU * 2), (surf ? 0.85 : 0.35) * light);
    }
    return S;
  }

  // ------------------------------------------------------------------ heart
  let heartPool = null;
  function heartF(x, y, z) {
    const a = x * x + 2.25 * y * y + z * z - 1;
    return a * a * a - x * x * z * z * z - 0.1125 * y * y * z * z * z;
  }
  function buildHeartPool() {
    const M = 60000;
    const pool = new Float32Array(M * 4);
    for (let i = 0; i < M; i++) {
      const d = unitVec();
      let lo = 0, hi = 2;
      for (let k = 0; k < 22; k++) {
        const m = (lo + hi) / 2;
        if (heartF(d[0] * m, d[2] * m, d[1] * m) <= 0) lo = m; else hi = m;
      }
      pool[i * 4] = d[0] * lo;
      pool[i * 4 + 1] = d[1] * lo;
      pool[i * 4 + 2] = d[2] * lo;
      pool[i * 4 + 3] = d[0] * 0.4 + d[1] * 0.6 + d[2] * 0.5;
    }
    return pool;
  }
  function heart(n) {
    if (!heartPool) heartPool = buildHeartPool();
    const S = alloc(n);
    const M = heartPool.length / 4;
    const sc = 1.3;
    const deep = [0.9, 0.04, 0.18], rose = [1.0, 0.35, 0.55], blush = [1.0, 0.7, 0.8];
    for (let i = 0; i < n; i++) {
      const k = Math.floor(R() * M) * 4;
      const inner = R() < 0.18;
      const f = inner ? Math.cbrt(R()) * 0.9 : 1 + gauss() * 0.008;
      const x = heartPool[k] * f * sc, y = (heartPool[k + 1] * f - 0.1) * sc, z = heartPool[k + 2] * f * sc;
      const lit = Math.max(0, heartPool[k + 3]);
      const c = inner ? deep : mix3(deep, lit > 0.55 ? blush : rose, Math.min(1, lit * 1.2));
      put(S, i, x, y, z, c, inner ? 0.35 : 0.65 + lit * 0.6);
    }
    return S;
  }

  // ------------------------------------------------------------------ text
  const FONT = '"Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", "Segoe UI", system-ui, sans-serif';
  function wrapText(str) {
    const lines = [];
    str.split(/\n|\s*\/\s*/).forEach((raw) => {
      const words = raw.trim().split(/\s+/).filter(Boolean);
      let line = '';
      words.forEach((w) => {
        const next = line ? line + ' ' + w : w;
        if (next.length > 12 && line) { lines.push(line); line = w; } else line = next;
      });
      if (line) lines.push(line);
    });
    return lines.length ? lines.slice(0, 4) : ['LUMEN'];
  }
  function text(n, str) {
    const lines = wrapText(str);
    const cw = 1800, lh = 360, ch = lh * lines.length + 80;
    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let size = 300;
    g.font = `800 ${size}px ${FONT}`;
    const widest = Math.max(...lines.map((l) => g.measureText(l).width));
    if (widest > cw * 0.94) size = Math.floor(size * (cw * 0.94) / widest);
    g.font = `800 ${size}px ${FONT}`;
    lines.forEach((l, k) => g.fillText(l, cw / 2, 40 + lh * (k + 0.5)));
    const data = g.getImageData(0, 0, cw, ch).data;
    const filled = [];
    let x0 = cw, x1 = 0, y0 = ch, y1 = 0;
    for (let y = 0; y < ch; y += 1) {
      for (let x = 0; x < cw; x += 1) {
        if (data[(y * cw + x) * 4 + 3] > 110) {
          filled.push(x, y);
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    const S = alloc(n);
    if (!filled.length) return nebula(n);
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const sc = Math.min(5.4 / bw, 2.9 / bh);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const cyan = [0.2, 0.75, 1.0], violet = [0.6, 0.35, 1.0], pink = [1.0, 0.35, 0.65];
    const count = filled.length / 2;
    for (let i = 0; i < n; i++) {
      if (R() < 0.06) {
        put(S, i, (R() - 0.5) * 8, (R() - 0.5) * 4.5, (R() - 0.5) * 3, [0.5, 0.6, 1.0], 0.22);
        continue;
      }
      const k = Math.floor(R() * count) * 2;
      const px = filled[k] + R(), py = filled[k + 1] + R();
      const x = (px - cx) * sc, y = -(py - cy) * sc;
      const t = (px - x0) / bw;
      const c = t < 0.5 ? mix3(cyan, violet, t * 2) : mix3(violet, pink, t * 2 - 1);
      put(S, i, x, y, gauss() * 0.035, c, 0.75);
    }
    return S;
  }

  // ------------------------------------------------------------------ image (relief by luminance)
  function image(n, img) {
    const maxDim = 700;
    const s = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    const data = g.getImageData(0, 0, w, h).data;
    const sc = Math.min(5.2 / w, 3.5 / h);
    const S = alloc(n);
    const lin = (v) => Math.pow(v / 255, 2.2);
    for (let i = 0; i < n; i++) {
      let x, y, k, tries = 0;
      do {
        x = Math.floor(R() * w); y = Math.floor(R() * h);
        k = (y * w + x) * 4;
      } while (data[k + 3] < 20 && ++tries < 8);
      const r = lin(data[k]), gg = lin(data[k + 1]), b = lin(data[k + 2]);
      const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      const px = (x + R() - w / 2) * sc, py = -(y + R() - h / 2) * sc;
      put(S, i, px, py, (Math.pow(lum, 0.45) - 0.5) * 0.9, [r, gg, b], data[k + 3] < 20 ? 0 : 0.95);
    }
    return S;
  }

  // ------------------------------------------------------------------ registry
  L.SHAPES = [
    { id: 'nebula', label: '성운', en: 'Nebula', line: '별이 태어나는 요람', mode: 1, color: 1, dist: 11.5, phi: 0.35, gen: nebula, gain: 0.8 },
    { id: 'galaxy', label: '은하', en: 'Spiral Galaxy', line: '천억 개의 태양이 그리는 소용돌이', mode: 0, color: 0, dist: 6.4, phi: 0.62, gen: galaxy, gain: 1.0 },
    { id: 'planet', label: '행성', en: 'Ringed World', line: '고리를 두른 거인', mode: 0, color: 0, dist: 6.8, phi: 0.36, gen: planet, gain: 1.0 },
    { id: 'butterfly', label: '나비', en: 'The Butterfly Effect', line: '작은 날갯짓 하나가 폭풍을 부른다', mode: 0, color: 0, anim: 1, dist: 6.0, phi: 0.45, gen: butterfly, gain: 0.9 },
    { id: 'lorenz', label: '끌개', en: 'Lorenz Attractor', line: '결코 같은 길을 두 번 지나지 않는 궤도', mode: 2, color: 2, dist: 7.0, phi: 0.12, gen: lorenz, gain: 0.8 },
    { id: 'dna', label: '나선', en: 'Double Helix', line: '생명을 적어 내려간 두 줄의 문장', mode: 0, color: 0, dist: 6.4, phi: 0.12, gen: dna, gain: 0.9 },
    { id: 'knot', label: '매듭', en: 'Torus Knot', line: '끝없이 이어지는 단 하나의 선', mode: 0, color: 0, dist: 6.2, phi: 0.5, gen: knot, gain: 0.85 },
    { id: 'heart', label: '심장', en: 'Heart', line: '음악에 맞춰 뛰는 심장', mode: 0, color: 0, anim: 2, dist: 5.8, phi: 0.12, gen: heart, gain: 0.9 },
  ];
  L.SPECIAL = {
    orb: { id: 'orb', label: '', en: '', mode: 0, color: 0, front: true, dist: 7.2, phi: 0, gain: 1.25, fitWidth: 0.8 },
    text: { id: 'text', label: '글자', en: 'Your Words', mode: 0, color: 0, front: true, dist: 6.0, phi: 0, gain: 0.8 },
    image: { id: 'image', label: '사진', en: 'Your Picture', line: '당신의 사진을 빛으로 다시 그리다', mode: 0, color: 0, front: true, dist: 6.0, phi: 0, gain: 1.0 },
    video: { id: 'video', label: '거울', en: 'Mirror', line: '빛으로 비추는 당신의 모습', mode: 3, color: 3, front: true, dist: 6.0, phi: 0, gain: 1.0 },
  };
  L.gen = { text, image, nebula, orb };
}

(function (L) {
  'use strict';
  lumenShapes(L);

  // Generates the geometric shapes in a worker; falls back to the main thread.
  class ShapeWorker {
    constructor() {
      this.req = 0;
      this.pending = new Map();
      try {
        const src = `const L = {}; (${lumenShapes.toString()})(L);
self.onmessage = (e) => {
  const { id, n, req } = e.data;
  const S = L.SHAPES.find((s) => s.id === id).gen(n);
  self.postMessage({ req, pos: S.pos, col: S.col }, [S.pos.buffer, S.col.buffer]);
};`;
        this.url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        this.worker = new Worker(this.url);
        this.worker.onmessage = (e) => {
          const cb = this.pending.get(e.data.req);
          this.pending.delete(e.data.req);
          if (cb) cb({ pos: e.data.pos, col: e.data.col });
        };
        this.worker.onerror = () => { this.worker = null; this.flushSync(); };
      } catch (e) {
        this.worker = null;
      }
    }
    generate(id, n, cb) {
      const req = ++this.req;
      if (!this.worker) {
        setTimeout(() => cb(L.SHAPES.find((s) => s.id === id).gen(n)), 0);
        return;
      }
      this.pending.set(req, cb);
      this.pending.get(req).args = [id, n];
      this.worker.postMessage({ id, n, req });
    }
    flushSync() {
      for (const [, cb] of this.pending) {
        const [id, n] = cb.args;
        cb(L.SHAPES.find((s) => s.id === id).gen(n));
      }
      this.pending.clear();
    }
  }
  L.ShapeWorker = ShapeWorker;
})(window.LUMEN = window.LUMEN || {});
