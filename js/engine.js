/* LUMEN — GPU particle engine: simulation, rendering and post-processing */
(function (L) {
  'use strict';

  const G = L.GL;
  const S = L.shaders;
  const MAX_SHOCKS = 8;

  class Engine {
    constructor(canvas) {
      const gl = canvas.getContext('webgl2', {
        antialias: false, alpha: false, depth: false, stencil: false,
        premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
      });
      if (!gl) throw new Error('NO_WEBGL2');
      if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('NO_FLOAT_RT');
      gl.getExtension('EXT_float_blend');
      this.gl = gl;
      this.canvas = canvas;

      this.pSim = G.program(gl, S.fullVS, S.simFS, 'sim');
      this.pDraw = G.program(gl, S.particleVS, S.particleFS, 'particles');
      this.pStars = G.program(gl, S.starsVS, S.particleFS, 'stars');
      this.pFade = G.program(gl, S.fullVS, S.fadeFS, 'fade');
      this.pDown = G.program(gl, S.fullVS, S.downFS, 'down');
      this.pUp = G.program(gl, S.fullVS, S.upFS, 'up');
      this.pComp = G.program(gl, S.fullVS, S.compositeFS, 'composite');
      this.vao = gl.createVertexArray();

      this.params = { bloom: 1.0, trail: 0.45, turb: 1.0, exposure: 1.0, size: 1.0 };
      this.shock = new Float32Array(MAX_SHOCKS * 4).fill(-1e4);
      this.shockP = new Float32Array(MAX_SHOCKS * 4).fill(1);
      this.shockIdx = 0;
      this.flash = 0;

      this.shape = null;
      this.shapeStart = 0;
      this.srcPrev = 1;
      this.srcCur = 1;
      this.slotCur = 0;
      this.videoTex = G.texture(gl, 2, 2, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR, null);
      this.videoAspect = 4 / 3;

      this.makeStars();
      this.W = this.H = 0;
    }

    // ------------------------------------------------------------ allocation
    setCount(N) {
      const gl = this.gl;
      if (this.N) {
        this.state.forEach((s) => { gl.deleteTexture(s.pos); gl.deleteTexture(s.vel); gl.deleteFramebuffer(s.fbo); });
        gl.deleteTexture(this.target);
        this.colTex.forEach((t) => gl.deleteTexture(t));
      }
      this.N = N;
      const f32 = () => G.texture(gl, N, N, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST, null);
      this.state = [0, 1].map(() => {
        const pos = f32(), vel = f32();
        return { pos, vel, fbo: G.framebuffer(gl, [pos, vel]) };
      });
      this.target = f32();
      this.colTex = [0, 1].map(() => G.texture(gl, N, N, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST, null));
      this.cur = 0;

      const init = new Float32Array(N * N * 4);
      for (let i = 0; i < N * N; i++) {
        const z = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - z * z);
        const r = Math.cbrt(Math.random()) * 3.2;
        init[i * 4] = s * Math.cos(a) * r;
        init[i * 4 + 1] = z * r * 0.8;
        init[i * 4 + 2] = s * Math.sin(a) * r;
        init[i * 4 + 3] = Math.random();
      }
      gl.bindTexture(gl.TEXTURE_2D, this.state[0].pos);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.FLOAT, init);
      this.points = null;
    }

    resize(w, h) {
      if (w === this.W && h === this.H) return;
      const gl = this.gl;
      this.W = w; this.H = h;
      this.canvas.width = w;
      this.canvas.height = h;
      if (this.hdr) {
        gl.deleteTexture(this.hdr.tex); gl.deleteFramebuffer(this.hdr.fbo);
        this.bloom.forEach((b) => { gl.deleteTexture(b.tex); gl.deleteFramebuffer(b.fbo); });
      }
      const rt = (W, H) => {
        const tex = G.texture(gl, W, H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR, null);
        return { tex, fbo: G.framebuffer(gl, [tex]), w: W, h: H };
      };
      this.hdr = rt(w, h);
      this.bloom = [];
      let bw = w >> 1, bh = h >> 1;
      while (this.bloom.length < 6 && bw >= 8 && bh >= 8) {
        this.bloom.push(rt(bw, bh));
        bw >>= 1; bh >>= 1;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdr.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    makeStars() {
      const gl = this.gl;
      const n = 2600;
      const data = new Float32Array(n * 7);
      for (let i = 0; i < n; i++) {
        const z = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - z * z);
        const t = Math.random();
        const c = t < 0.2 ? [0.7, 0.8, 1.0] : t < 0.3 ? [1.0, 0.85, 0.65] : [0.9, 0.9, 1.0];
        const b = Math.pow(Math.random(), 3) * 0.9 + 0.08;
        data.set([s * Math.cos(a) * 50, z * 50, s * Math.sin(a) * 50, c[0] * b, c[1] * b, c[2] * b, 1 + Math.random() * 1.6], i * 7);
      }
      this.starVao = gl.createVertexArray();
      gl.bindVertexArray(this.starVao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
      gl.bindVertexArray(null);
      this.starCount = n;
    }

    // ------------------------------------------------------------ shapes
    // data: {pos, col} from a generator; null for purely procedural modes
    setShape(def, data, time) {
      const gl = this.gl;
      const N = this.N;
      this.srcPrev = this.srcCur;
      this.slotPrev = this.slotCur;
      if (def.color === 0 && data) {
        const slot = this.srcPrev === 0 ? 1 - this.slotPrev : this.slotPrev;
        gl.bindTexture(gl.TEXTURE_2D, this.colTex[slot]);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, data.col);
        this.slotCur = slot;
      }
      if (def.mode === 0 && data) {
        gl.bindTexture(gl.TEXTURE_2D, this.target);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.FLOAT, data.pos);
      }
      this.srcCur = def.color;
      this.shape = def;
      this.points = data ? data.pos : null;
      this.shapeStart = time;
    }

    randomPoint() {
      const P = this.points;
      if (!P) return [(Math.random() - 0.5) * 4, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 1];
      const k = Math.floor(Math.random() * (P.length / 4)) * 4;
      return [P[k], P[k + 1], P[k + 2]];
    }

    addShock(pos, strength, speed, width, life, time) {
      const i = this.shockIdx;
      this.shockIdx = (i + 1) % MAX_SHOCKS;
      this.shock.set([pos[0], pos[1], pos[2], time], i * 4);
      this.shockP.set([strength, speed, width, life], i * 4);
    }

    updateVideo(video) {
      if (!video || video.readyState < 2) return;
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);
      this.videoAspect = video.videoWidth / video.videoHeight || 4 / 3;
    }

    // ------------------------------------------------------------ frame
    step(dt, time, u) {
      const gl = this.gl;
      const N = this.N;
      const src = this.state[this.cur], dst = this.state[1 - this.cur];
      const p = G.use(this.pSim);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, N, N);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(this.vao);
      G.tex(p, 'uPos', src.pos);
      G.tex(p, 'uVel', src.vel);
      G.tex(p, 'uTarget', this.target);
      G.tex(p, 'uVideo', this.videoTex);
      const def = this.shape || {};
      G.setAll(p, {
        uNf: N,
        uTime: time,
        uDt: dt,
        uShapeTime: time - this.shapeStart,
        uMode: def.mode || 0,
        uAnim: def.anim || 0,
        uPulse: u.pulse,
        uTurb: this.params.turb,
        uSpring: 11.0,
        uBass: u.bass,
        uVideoAspect: this.videoAspect,
        uRayO: u.rayO,
        uRayD: u.rayD,
        uPointer: u.pointer,
        uPointerVel: u.pointerVel,
        uHold: u.hold,
        uShock: this.shock,
        uShockP: this.shockP,
      });
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.cur = 1 - this.cur;
    }

    render(cam, time, u) {
      const gl = this.gl;
      const { W, H } = this;
      const st = this.state[this.cur];
      const trail = this.params.trail;
      const def = this.shape || {};

      // --- HDR particle pass
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdr.fbo);
      gl.viewport(0, 0, W, H);
      gl.enable(gl.BLEND);
      gl.bindVertexArray(this.vao);
      if (trail > 0.01) {
        G.use(this.pFade);
        gl.blendFunc(gl.ZERO, gl.CONSTANT_ALPHA);
        gl.blendColor(0, 0, 0, trail);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      } else {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.blendFunc(gl.ONE, gl.ONE);
      const keep = 1 - trail;
      const projScale = H / (2 * Math.tan(cam.fov / 2));

      let p = G.use(this.pStars);
      G.setAll(p, { uProj: cam.proj, uView: cam.view, uTime: time, uIntensity: 0.9 * keep, uScale: Math.max(1, H / 900) });
      gl.bindVertexArray(this.starVao);
      gl.drawArrays(gl.POINTS, 0, this.starCount);

      const N = this.N;
      p = G.use(this.pDraw);
      gl.bindVertexArray(this.vao);
      G.tex(p, 'uPos', st.pos);
      G.tex(p, 'uVel', st.vel);
      G.tex(p, 'uColPrev', this.colTex[this.slotPrev || 0]);
      G.tex(p, 'uColCur', this.colTex[this.slotCur]);
      G.tex(p, 'uVideo', this.videoTex);
      const density = Math.pow(1048576 / (N * N), 0.8);
      G.setAll(p, {
        uSrcPrev: this.srcPrev,
        uSrcCur: this.srcCur,
        uN: N,
        uProj: cam.proj,
        uView: cam.view,
        uTime: time,
        uShapeTime: time - this.shapeStart,
        uPointScale: 0.0105 * projScale * this.params.size,
        uIntensity: 0.2 * keep * density * (def.gain || 1),
        uHigh: u.high,
      });
      gl.drawArrays(gl.POINTS, 0, N * N);
      gl.disable(gl.BLEND);

      // --- bloom: dual-filter down / up chain
      const B = this.bloom;
      p = G.use(this.pDown);
      for (let i = 0; i < B.length; i++) {
        const srcTex = i === 0 ? this.hdr.tex : B[i - 1].tex;
        const sw = i === 0 ? W : B[i - 1].w, sh = i === 0 ? H : B[i - 1].h;
        gl.bindFramebuffer(gl.FRAMEBUFFER, B[i].fbo);
        gl.viewport(0, 0, B[i].w, B[i].h);
        p.unit = 0;
        G.tex(p, 'uSrc', srcTex);
        G.setAll(p, { uTexel: [1 / sw, 1 / sh], uFirst: i === 0 ? 1 : 0, uThreshold: 0.55 });
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      p = G.use(this.pUp);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = B.length - 1; i > 0; i--) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, B[i - 1].fbo);
        gl.viewport(0, 0, B[i - 1].w, B[i - 1].h);
        p.unit = 0;
        G.tex(p, 'uSrc', B[i].tex);
        G.setAll(p, { uTexel: [1 / B[i].w, 1 / B[i].h], uWeight: 0.85 });
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.BLEND);

      this.present(time);
    }

    // Composite the HDR + bloom buffers onto the canvas.
    present(time) {
      const gl = this.gl;
      const { W, H } = this;
      const B = this.bloom;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.bindVertexArray(this.vao);
      const p = G.use(this.pComp);
      G.tex(p, 'uHdr', this.hdr.tex);
      G.tex(p, 'uBloom', B[0].tex);
      G.setAll(p, {
        uBloomStr: this.params.bloom * 0.22,
        uExposure: this.params.exposure,
        uTime: time,
        uRes: [W, H],
        uFlash: this.flash,
      });
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  L.Engine = Engine;
})(window.LUMEN = window.LUMEN || {});
