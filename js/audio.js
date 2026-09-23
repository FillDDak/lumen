/* LUMEN — generative audio engine (Web Audio API, no samples)
 *
 * A slow chord progression of detuned pads, a sparse FM-bell melody that gets
 * busier as you interact, and interaction sounds. Scheduled notes are also
 * emitted as events so the visuals can ripple in time with the music.
 */
(function (L) {
  'use strict';

  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const BPM = 76;
  const STEP = 60 / BPM / 2; // eighth note
  const CHORDS = [
    { root: 38, notes: [50, 57, 61, 64, 66] }, // Dmaj9
    { root: 35, notes: [47, 54, 57, 62, 64] }, // Bm11
    { root: 31, notes: [43, 50, 54, 59, 61] }, // Gmaj7#11
    { root: 33, notes: [45, 52, 57, 59, 64] }, // A(add9, sus)
  ];
  const SCALE = [62, 64, 66, 69, 71, 74, 76, 78, 81, 83, 86, 88]; // D major pentatonic

  class AudioEngine {
    constructor() {
      this.ready = false;
      this.muted = false;
      this.volume = 0.8;
      this.events = [];
      this.energy = 0;
      this.heart = false;
      this.micOn = false;
      this.bands = { bass: 0, mid: 0, high: 0 };
      this.melodyIdx = 5;
    }

    init() {
      if (this.ready) return;
      // iOS 17+: play through the ringer/silent switch like a media app
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* unsupported */ }
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));

      this.master = ctx.createGain();
      this.master.gain.value = 0;
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -16;
      this.comp.knee.value = 12;
      this.comp.ratio.value = 3.5;
      this.comp.attack.value = 0.01;
      this.comp.release.value = 0.3;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.7;
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);

      this.music = ctx.createGain();
      this.fx = ctx.createGain();
      this.dry = ctx.createGain();
      this.music.connect(this.dry);
      this.fx.connect(this.dry);
      this.dry.connect(this.comp);

      this.reverb = ctx.createConvolver();
      this.reverb.buffer = this.impulse(5, 2.6);
      this.revSend = ctx.createGain();
      this.revReturn = ctx.createGain();
      this.revReturn.gain.value = 0.9;
      this.revSend.connect(this.reverb).connect(this.revReturn).connect(this.comp);

      this.delay = ctx.createDelay(3);
      this.delay.delayTime.value = STEP * 3;
      this.delayFb = ctx.createGain();
      this.delayFb.gain.value = 0.38;
      this.delayTone = ctx.createBiquadFilter();
      this.delayTone.type = 'lowpass';
      this.delayTone.frequency.value = 2400;
      this.delaySend = ctx.createGain();
      this.delaySend.connect(this.delay);
      this.delay.connect(this.delayTone);
      this.delayTone.connect(this.delayFb).connect(this.delay);
      this.delayTone.connect(this.comp);
      this.delayTone.connect(this.revSend);

      this.comp.connect(this.master);
      this.master.connect(this.analyser);
      this.analyser.connect(ctx.destination);
      this.streamDest = ctx.createMediaStreamDestination();
      this.master.connect(this.streamDest);

      const len = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const nd = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) nd[i] = Math.random() * 2 - 1;

      this.ready = true;
      this.setVolume(this.volume);
      this.stepIdx = 0;
      this.nextTime = ctx.currentTime + 0.1;
      this.timer = setInterval(() => this.tick(), 25);
      if (ctx.state === 'suspended') ctx.resume();
    }

    impulse(sec, decay) {
      const ctx = this.ctx;
      const len = Math.floor(ctx.sampleRate * sec);
      const buf = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        let lp = 0;
        for (let i = 0; i < len; i++) {
          const env = Math.pow(1 - i / len, decay);
          lp += ((Math.random() * 2 - 1) - lp) * (0.25 + 0.7 * (1 - i / len));
          d[i] = lp * env;
        }
      }
      return buf;
    }

    // voice output helper: routes a node to dry / reverb / delay buses
    route(node, bus, rev, dly, pan) {
      const ctx = this.ctx;
      let out = node;
      if (pan) {
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        node.connect(p);
        out = p;
      }
      out.connect(bus);
      if (rev) { const g = ctx.createGain(); g.gain.value = rev; out.connect(g).connect(this.revSend); }
      if (dly) { const g = ctx.createGain(); g.gain.value = dly; out.connect(g).connect(this.delaySend); }
    }

    setVolume(v) {
      this.volume = v;
      if (!this.ready) return;
      const target = this.muted ? 0 : v;
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.4);
    }
    setMuted(m) {
      this.muted = m;
      this.setVolume(this.volume);
    }

    // ------------------------------------------------------------ sequencer
    tick() {
      const ctx = this.ctx;
      if (ctx.state !== 'running') return;
      if (this.nextTime < ctx.currentTime - 1) this.nextTime = ctx.currentTime + 0.05;
      while (this.nextTime < ctx.currentTime + 0.15) {
        this.step(this.stepIdx, this.nextTime);
        this.nextTime += STEP;
        this.stepIdx++;
      }
      const now = ctx.currentTime;
      if (this.events.length > 64) this.events = this.events.filter((e) => e.t > now - 1);
      this.energy *= 0.985;
    }

    step(i, t) {
      const s16 = i % 16;
      if (s16 === 0) {
        this.chord = CHORDS[Math.floor(i / 16) % CHORDS.length];
        this.pad(this.chord.notes, t, STEP * 16);
        this.sub(this.chord.root, t, STEP * 16);
        this.emit(t, 'chord', { idx: Math.floor(i / 16) % CHORDS.length });
      }
      const chord = this.chord;
      if ([0, 3, 6, 10, 13].includes(s16) && Math.random() < 0.45 + this.energy * 0.4) {
        const n = chord.notes[Math.floor(Math.random() * chord.notes.length)] + 12;
        this.bell(n, t + Math.random() * 0.01, 0.1, (Math.random() - 0.5) * 0.8, 2.2, 2.0);
      }
      if (Math.random() < 0.14 + this.energy * 0.45) {
        this.melodyIdx += Math.round((Math.random() - 0.5) * 4);
        this.melodyIdx = Math.max(0, Math.min(SCALE.length - 1, this.melodyIdx));
        const n = SCALE[this.melodyIdx];
        const vel = 0.16 + Math.random() * 0.12;
        this.bell(n, t, vel, (Math.random() - 0.5) * 1.2, 3.2, 3.5);
        this.emit(t, 'note', { midi: n, vel });
      }
      if (this.heart && i % 2 === 0) {
        this.thump(t, 1);
        this.thump(t + 0.21, 0.55);
        this.emit(t, 'beat', { amp: 1 });
        this.emit(t + 0.21, 'beat', { amp: 0.55 });
      }
    }

    emit(t, type, data) {
      this.events.push(Object.assign({ t, type }, data));
    }

    // Deliver events whose scheduled time has arrived.
    poll(cb) {
      if (!this.ready || !this.events.length) return;
      const now = this.ctx.currentTime;
      const keep = [];
      for (const e of this.events) (e.t <= now ? cb(e) : keep.push(e));
      this.events = keep;
    }

    // ------------------------------------------------------------ voices
    pad(notes, t, dur) {
      const ctx = this.ctx;
      const out = ctx.createGain();
      out.gain.setValueAtTime(0, t);
      out.gain.linearRampToValueAtTime(0.028, t + 2.5);
      out.gain.setValueAtTime(0.028, t + dur);
      out.gain.linearRampToValueAtTime(0, t + dur + 3.5);
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 900;
      filt.Q.value = 0.8;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.09;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 450;
      lfo.connect(lfoGain).connect(filt.frequency);
      const end = t + dur + 3.7;
      const oscs = [lfo];
      notes.forEach((n) => {
        [-8, 8].forEach((det) => {
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = mtof(n);
          o.detune.value = det + (Math.random() - 0.5) * 4;
          o.connect(filt);
          oscs.push(o);
        });
      });
      filt.connect(out);
      this.route(out, this.music, 0.9, 0.05, 0);
      oscs.forEach((o) => { o.start(t); o.stop(end); });
    }

    sub(root, t, dur) {
      const ctx = this.ctx;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = mtof(root);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.16, t + 1.2);
      g.gain.setTargetAtTime(0.0, t + dur * 0.6, 1.2);
      o.connect(g);
      this.route(g, this.music, 0.15, 0, 0);
      o.start(t);
      o.stop(t + dur + 4);
    }

    bell(midi, t, vel, pan, dur, ratio) {
      const ctx = this.ctx;
      const f = mtof(midi);
      const car = ctx.createOscillator();
      car.frequency.value = f;
      const mod = ctx.createOscillator();
      mod.frequency.value = f * (ratio || 3.5);
      const idx = ctx.createGain();
      idx.gain.setValueAtTime(f * 2.2 * (0.5 + vel), t);
      idx.gain.exponentialRampToValueAtTime(f * 0.05 + 1, t + dur * 0.4);
      mod.connect(idx).connect(car.frequency);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(vel, t + 0.006);
      env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      car.connect(env);
      this.route(env, this.music, 0.65, 0.35, pan);
      car.start(t); mod.start(t);
      car.stop(t + dur + 0.05); mod.stop(t + dur + 0.05);
    }

    thump(t, amp) {
      const ctx = this.ctx;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(95, t);
      o.frequency.exponentialRampToValueAtTime(38, t + 0.25);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.55 * amp, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.connect(g);
      this.route(g, this.music, 0.2, 0, 0);
      o.start(t);
      o.stop(t + 0.45);
    }

    noiseSrc() {
      const s = this.ctx.createBufferSource();
      s.buffer = this.noise;
      s.loop = true;
      return s;
    }

    // ------------------------------------------------------------ interaction sounds
    pluckAt(xn, yn, strength) {
      if (!this.ready) return null;
      const t = this.ctx.currentTime + 0.005;
      const idx = Math.max(0, Math.min(SCALE.length - 1, Math.floor(xn * SCALE.length)));
      const n = SCALE[idx] + (yn < 0.35 ? 12 : yn > 0.75 ? -12 : 0);
      this.bell(n, t, 0.12 + strength * 0.2, (xn - 0.5) * 1.4, 2.6, 2.0);
      this.energy = Math.min(1, this.energy + 0.08);
      return n;
    }

    whoosh() {
      if (!this.ready) return;
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const src = this.noiseSrc();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.6;
      bp.frequency.setValueAtTime(180, t);
      bp.frequency.exponentialRampToValueAtTime(3200, t + 1.1);
      bp.frequency.exponentialRampToValueAtTime(300, t + 2.8);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.9);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 3);
      src.connect(bp).connect(g);
      this.route(g, this.fx, 0.8, 0, 0);
      src.start(t);
      src.stop(t + 3.1);
      // shimmering arpeggio
      const base = this.chord ? this.chord.notes : CHORDS[0].notes;
      for (let k = 0; k < 6; k++) {
        this.bell(base[k % base.length] + 24, t + 0.55 + k * 0.09, 0.07, (k / 5 - 0.5) * 1.4, 2.4, 3.0);
      }
    }

    boom(power) {
      if (!this.ready) return;
      const ctx = this.ctx;
      const t = ctx.currentTime + 0.01;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(130, t);
      o.frequency.exponentialRampToValueAtTime(32, t + 0.9);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.7 * power, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      o.connect(g);
      this.route(g, this.fx, 0.5, 0, 0);
      o.start(t);
      o.stop(t + 1.5);
      const n = this.noiseSrc();
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(2400 * power + 400, t);
      lp.frequency.exponentialRampToValueAtTime(80, t + 1.6);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.35 * power, t);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
      n.connect(lp).connect(ng);
      this.route(ng, this.fx, 0.9, 0, 0);
      n.start(t);
      n.stop(t + 1.9);
      this.energy = Math.min(1, this.energy + 0.3 * power);
    }

    holdStart() {
      if (!this.ready || this.holdNodes) return;
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const o1 = ctx.createOscillator();
      const o2 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o2.type = 'sawtooth';
      o1.frequency.value = 55;
      o2.frequency.value = 55 * 1.5;
      o2.detune.value = 7;
      const n = this.noiseSrc();
      const nf = ctx.createBiquadFilter();
      nf.type = 'bandpass';
      nf.frequency.value = 400;
      nf.Q.value = 3;
      const ng = ctx.createGain();
      ng.gain.value = 0.3;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 200;
      lp.Q.value = 6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      o1.connect(lp); o2.connect(lp);
      n.connect(nf).connect(ng).connect(lp);
      lp.connect(g);
      this.route(g, this.fx, 0.6, 0.2, 0);
      o1.start(t); o2.start(t); n.start(t);
      this.holdNodes = { o1, o2, n, lp, nf, g };
    }

    holdUpdate(h) {
      const H = this.holdNodes;
      if (!H) return;
      const t = this.ctx.currentTime;
      H.g.gain.setTargetAtTime(0.16 * h, t, 0.08);
      H.lp.frequency.setTargetAtTime(200 + h * h * 2600, t, 0.1);
      H.o1.frequency.setTargetAtTime(55 * (1 + h * 1.0), t, 0.2);
      H.o2.frequency.setTargetAtTime(82.5 * (1 + h * 1.0), t, 0.2);
      H.nf.frequency.setTargetAtTime(400 + h * 3000, t, 0.1);
    }

    holdEnd() {
      const H = this.holdNodes;
      if (!H) return;
      const t = this.ctx.currentTime;
      H.g.gain.cancelScheduledValues(t);
      H.g.gain.setTargetAtTime(0, t, 0.05);
      [H.o1, H.o2, H.n].forEach((o) => o.stop(t + 0.4));
      this.holdNodes = null;
    }

    // ------------------------------------------------------------ microphone
    async enableMic() {
      if (!this.ready) this.init();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
      this.micStream = stream;
      this.micSrc = this.ctx.createMediaStreamSource(stream);
      this.micAnalyser = this.ctx.createAnalyser();
      this.micAnalyser.fftSize = 2048;
      this.micAnalyser.smoothingTimeConstant = 0.6;
      this.micSrc.connect(this.micAnalyser);
      this.micOn = true;
      this.music.gain.setTargetAtTime(0.0, this.ctx.currentTime, 0.5);
    }
    disableMic() {
      if (this.micStream) this.micStream.getTracks().forEach((t) => t.stop());
      if (this.micSrc) this.micSrc.disconnect();
      this.micStream = this.micSrc = null;
      this.micOn = false;
      if (this.ready) this.music.gain.setTargetAtTime(1, this.ctx.currentTime, 0.5);
    }

    // ------------------------------------------------------------ analysis
    analyse() {
      const b = this.bands;
      if (!this.ready) return b;
      const an = this.micOn && this.micAnalyser ? this.micAnalyser : this.analyser;
      an.getByteFrequencyData(this.freq);
      const hz = this.ctx.sampleRate / an.fftSize;
      const avg = (lo, hi) => {
        const a = Math.max(1, Math.floor(lo / hz)), z = Math.min(this.freq.length - 1, Math.ceil(hi / hz));
        let s = 0;
        for (let i = a; i <= z; i++) s += this.freq[i];
        return s / ((z - a + 1) * 255);
      };
      const gain = this.micOn ? 1.6 : 1.0;
      const bass = Math.min(1, avg(30, 160) * gain);
      const mid = Math.min(1, avg(300, 2000) * gain);
      const high = Math.min(1, avg(3000, 9000) * gain * 2.2);
      b.bass += (bass - b.bass) * 0.25;
      b.mid += (mid - b.mid) * 0.25;
      // sparkle on transients (new notes), not on the steady level
      this.slowHigh = (this.slowHigh || 0) + (high - (this.slowHigh || 0)) * 0.03;
      const hit = Math.max(0, high - this.slowHigh * 1.05) * 5;
      b.high += (Math.min(1, hit) - b.high) * (hit > b.high ? 0.6 : 0.12);
      return b;
    }
  }

  L.AudioEngine = AudioEngine;
})(window.LUMEN = window.LUMEN || {});
