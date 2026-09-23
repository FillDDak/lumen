/* LUMEN — application: input, camera, UI, tour and the frame loop */
(function (L) {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const { V, M, U } = L;
  const TAU = Math.PI * 2;

  // ------------------------------------------------------------ settings
  const store = {
    get(k, d) { try { const v = localStorage.getItem('lumen.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('lumen.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  const coarse = matchMedia('(pointer: coarse)').matches;
  const DEFAULTS = { count: coarse ? 512 : 1024, trail: 0.45, bloom: 1.0, turb: 1.0, exposure: 1.0, size: 1.0, volume: 0.8, orbit: true, userCount: false };
  const settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
  const saveSettings = () => store.set('settings', settings);

  // ------------------------------------------------------------ boot
  const canvas = $('#gl');
  let engine;
  try {
    engine = new L.Engine(canvas);
  } catch (e) {
    console.error(e);
    $('#fatal').hidden = false;
    $('#fatalMsg').textContent = String(e.message || e);
    $('#intro').remove();
    return;
  }
  const audio = new L.AudioEngine();
  audio.volume = settings.volume;
  Object.assign(engine.params, { trail: settings.trail, bloom: settings.bloom, turb: settings.turb, exposure: settings.exposure, size: settings.size });

  const params = new URLSearchParams(location.search);
  if (params.get('n')) { settings.count = +params.get('n'); }
  engine.setCount(settings.count);

  // ------------------------------------------------------------ state
  let time = 0;
  let current = null;
  let lastSource = null; // how to regenerate the current shape (after a count change)
  let pulse = 0;
  let beatClock = 0;
  let started = false;
  let videoStream = null;
  const video = $('#video');

  const cam = {
    fov: (45 * Math.PI) / 180,
    theta: 0.4, phi: 0.35, dist: 9,
    tTheta: 0.4, tPhi: 0.35, baseDist: 7.2, zoom: 1,
    front: false,
    proj: new Float32Array(16), view: new Float32Array(16),
    eye: [0, 0, 9], basis: null,
  };

  const ptr = {
    x: 0, y: 0, inside: false,
    down: false, downT: 0, downX: 0, downY: 0, orbit: false,
    hold: 0, holding: false,
    accX: 0, accY: 0, vel: [0, 0, 0],
    lastPluck: 0, world: [0, 0, 0],
    stroke: false, touch: false, lastMoveT: 0,
  };
  const touches = new Map();
  let pinch = null;

  // ------------------------------------------------------------ shapes
  function applyShape(def, data, opts = {}) {
    engine.setShape(def, data, time);
    current = def;
    cam.front = !!def.front;
    if (cam.front) {
      cam.tTheta = Math.round(cam.theta / TAU) * TAU;
      cam.tPhi = 0;
    } else {
      cam.tPhi = def.phi;
    }
    cam.baseDist = def.dist;
    audio.heart = def.anim === 2;
    if (!opts.quiet) audio.whoosh();
    engine.addShock([0, 0, 0], 4, 4.5, 0.8, 1.4, time);
    if (!opts.noCaption) caption(def);
    markActive(def.id);
    if (def.id !== 'video') stopVideo();
  }

  const shapeWorker = new L.ShapeWorker();
  let shapeReq = 0;

  function selectShape(id, opts = {}) {
    const def = L.SHAPES.find((s) => s.id === id);
    if (!def) return;
    lastSource = { type: 'shape', id };
    if (!opts.fromTour) setTour(false);
    // respond instantly; the particles follow once the worker has the shape
    markActive(id);
    if (!opts.quiet) audio.whoosh();
    const req = ++shapeReq;
    const n = engine.N * engine.N;
    shapeWorker.generate(id, n, (data) => {
      if (req !== shapeReq || data.pos.length !== engine.N * engine.N * 4) return;
      applyShape(def, data, Object.assign({}, opts, { quiet: true }));
    });
  }

  function markActive(id) {
    document.querySelectorAll('.dock-btn[data-shape]').forEach((b) => b.classList.toggle('active', b.dataset.shape === id));
    $('#btnText').classList.toggle('active', id === 'text');
    $('#btnImage').classList.toggle('active', id === 'image');
    $('#btnMirror').classList.toggle('active', id === 'video');
  }

  function showText(str, opts = {}) {
    str = (str || '').trim();
    if (!str) return;
    shapeReq++;
    const data = L.gen.text(engine.N * engine.N, str);
    lastSource = { type: 'text', value: str };
    applyShape(L.SPECIAL.text, data, Object.assign({ noCaption: true }, opts));
    if (!opts.fromTour) setTour(false);
  }

  function showImage(img) {
    shapeReq++;
    const data = L.gen.image(engine.N * engine.N, img);
    lastSource = { type: 'image', value: img };
    applyShape(L.SPECIAL.image, data);
    setTour(false);
  }

  function loadImageFile(file) {
    if (!file || !/^image\//.test(file.type)) { toast('이미지 파일만 빛으로 그릴 수 있어요'); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { showImage(img); URL.revokeObjectURL(url); };
    img.onerror = () => toast('사진을 읽지 못했어요');
    img.src = url;
  }

  async function startVideo() {
    if (videoStream) return;
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
      video.srcObject = videoStream;
      await video.play();
      lastSource = { type: 'video' };
      shapeReq++;
      applyShape(L.SPECIAL.video, null);
      setTour(false);
      $('#btnMirror').classList.add('active');
    } catch (e) {
      console.warn(e);
      videoStream = null;
      toast('카메라를 켤 수 없어요 — 브라우저의 카메라 권한을 확인해주세요');
    }
  }
  function stopVideo() {
    if (!videoStream) return;
    videoStream.getTracks().forEach((t) => t.stop());
    videoStream = null;
    video.srcObject = null;
  }

  function regenerate() {
    const s = lastSource;
    if (!s) return selectShape('nebula', { quiet: true, fromTour: true });
    if (s.type === 'shape') selectShape(s.id, { quiet: true, fromTour: tour.on, noCaption: true });
    else if (s.type === 'text') showText(s.value, { quiet: true, fromTour: tour.on });
    else if (s.type === 'image') showImage(s.value);
    else if (s.type === 'video') applyShape(L.SPECIAL.video, null, { quiet: true });
  }

  function setCount(n) {
    if (n === engine.N) return;
    engine.setCount(n);
    regenerate();
    updateStats(true);
  }

  // ------------------------------------------------------------ tour
  const TOUR = ['galaxy', 'butterfly', 'planet', 'lorenz', 'dna', 'heart', 'knot', 'nebula'];
  const tour = { on: false, idx: 0, next: 0 };
  function setTour(on) {
    tour.on = on;
    const b = $('#btnTour');
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.querySelector('use').setAttribute('href', on ? '#i-pause' : '#i-play');
    if (on) {
      const i = current ? TOUR.indexOf(current.id) : -1;
      tour.idx = i >= 0 ? i + 1 : tour.idx;
      tour.next = time + (i >= 0 ? 6 : 0);
    }
  }

  // ------------------------------------------------------------ UI helpers
  let captionTimer = 0;
  function caption(def) {
    const el = $('#caption');
    el.classList.remove('show');
    clearTimeout(captionTimer);
    captionTimer = setTimeout(() => {
      el.querySelector('.cap-en').textContent = def.en || '';
      el.querySelector('.cap-ko').textContent = def.label || '';
      el.querySelector('.cap-line').textContent = def.line || '';
      el.classList.add('show');
      captionTimer = setTimeout(() => el.classList.remove('show'), 5200);
    }, 450);
  }

  let toastTimer = 0;
  function toast(msg, ms = 2800) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  const HINTS = coarse
    ? ['손가락으로 빛을 쓸어보세요', '길게 누르면 블랙홀이 생겨요 — 놓으면 폭발!', '두 손가락으로 돌리고 확대할 수 있어요']
    : ['빛 사이로 커서를 휘저어 보세요', '길게 누르면 블랙홀이 생겨요 — 놓으면 폭발!', '오른쪽 드래그로 회전, 휠로 확대', '사진을 화면에 끌어다 놓아보세요'];
  let hintIdx = 0;
  function cycleHints() {
    const el = $('#gestureHint');
    if (hintIdx >= HINTS.length) { el.classList.remove('show'); return; }
    el.textContent = HINTS[hintIdx++];
    el.classList.add('show');
    setTimeout(() => { el.classList.remove('show'); setTimeout(cycleHints, 1400); }, 3800);
  }

  function openPanel(id) {
    const el = $(id);
    const willOpen = !el.classList.contains('open');
    document.querySelectorAll('.panel.open').forEach((p) => p.classList.remove('open'));
    if (willOpen) el.classList.add('open');
    return willOpen;
  }
  function closePanels() {
    document.querySelectorAll('.panel.open').forEach((p) => p.classList.remove('open'));
  }

  let fpsFrames = 0, fpsTime = 0, fps = 60;
  function updateStats(force) {
    const n = engine.N * engine.N;
    if (force || fpsTime > 0.5) {
      if (fpsTime > 0) fps = fpsFrames / fpsTime;
      fpsFrames = 0;
      fpsTime = 0;
      $('#stats').textContent = `${n.toLocaleString('ko-KR')}개의 빛 · ${Math.round(fps)} fps`;
    }
  }

  // ------------------------------------------------------------ dock
  const dockShapes = $('#dockShapes');
  L.SHAPES.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'dock-btn';
    b.type = 'button';
    b.dataset.shape = s.id;
    b.title = `${s.label} · ${s.en} (${i + 1})`;
    b.innerHTML = `<svg><use href="#i-${s.id}"/></svg><span>${s.label}</span><kbd>${i + 1}</kbd>`;
    b.addEventListener('click', () => selectShape(s.id));
    dockShapes.appendChild(b);
  });

  $('#btnText').addEventListener('click', () => {
    if (openPanel('#textPanel')) setTimeout(() => $('#textInput').focus(), 50);
  });
  $('#textPanel').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#textInput').value;
    if (!v.trim()) { $('#textInput').focus(); return; }
    showText(v);
    closePanels();
    $('#textInput').blur();
  });
  $('#btnImage').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', (e) => { loadImageFile(e.target.files[0]); e.target.value = ''; });
  $('#btnMirror').addEventListener('click', () => (current && current.id === 'video' ? selectShape('nebula') : startVideo()));
  $('#btnMic').addEventListener('click', async () => {
    const b = $('#btnMic');
    if (audio.micOn) {
      audio.disableMic();
      b.classList.remove('on');
      toast('마이크를 껐어요 — 다시 음악이 흐릅니다');
      return;
    }
    try {
      await audio.enableMic();
      b.classList.add('on');
      toast('마이크를 켰어요 — 말하거나, 노래하거나, 음악을 틀어보세요');
    } catch (e) {
      console.warn(e);
      toast('마이크를 켤 수 없어요 — 권한을 확인해주세요');
    }
  });

  // ------------------------------------------------------------ top actions
  $('#btnTour').addEventListener('click', () => setTour(!tour.on));
  function syncSoundIcon() {
    const muted = !audio.ready || audio.muted;
    $('#btnSound use').setAttribute('href', muted ? '#i-muted' : '#i-sound');
    $('#btnSound').classList.toggle('on', !muted);
  }
  function toggleSound() {
    if (!audio.ready) { audio.init(); audio.setMuted(false); }
    else audio.setMuted(!audio.muted);
    syncSoundIcon();
    toast(audio.muted ? '소리를 껐어요' : '소리를 켰어요');
  }
  $('#btnSound').addEventListener('click', toggleSound);

  let wantShot = false;
  $('#btnShot').addEventListener('click', () => { wantShot = true; });
  function saveShot() {
    canvas.toBlob((blob) => {
      if (!blob) return;
      download(blob, `lumen-${stamp()}.png`);
      toast('스크린샷을 저장했어요');
    }, 'image/png');
  }
  function stamp() {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  let recorder = null, recStart = 0, recTimer = 0;
  function toggleRecord() {
    if (recorder) { recorder.stop(); return; }
    if (!window.MediaRecorder || !canvas.captureStream) { toast('이 브라우저는 녹화를 지원하지 않아요'); return; }
    const stream = canvas.captureStream(60);
    if (audio.ready) audio.streamDest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const chunks = [];
    try {
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 16e6 });
    } catch (e) {
      toast('녹화를 시작할 수 없어요');
      return;
    }
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      const ext = (recorder.mimeType || mimeType).includes('mp4') ? 'mp4' : 'webm';
      download(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }), `lumen-${stamp()}.${ext}`);
      recorder = null;
      clearInterval(recTimer);
      $('#btnRecord').classList.remove('on');
      $('#recTime').textContent = '';
      toast('녹화한 영상을 저장했어요');
    };
    recorder.start(250);
    recStart = performance.now();
    $('#btnRecord').classList.add('on');
    const tick = () => {
      const s = Math.floor((performance.now() - recStart) / 1000);
      $('#recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    recTimer = setInterval(tick, 500);
    toast('녹화 중 — 다시 누르면 저장돼요');
  }
  $('#btnRecord').addEventListener('click', toggleRecord);

  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
  }
  $('#btnFull').addEventListener('click', toggleFull);
  $('#btnSettings').addEventListener('click', () => openPanel('#settingsPanel'));
  $('#btnHelp').addEventListener('click', () => openPanel('#helpPanel'));
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanels));

  // ------------------------------------------------------------ settings panel
  const bind = (id, key, fmt, apply) => {
    const el = $(id);
    const out = $('#o' + id.slice(4));
    el.value = settings[key];
    if (out) out.textContent = fmt(settings[key]);
    el.addEventListener('input', () => {
      settings[key] = parseFloat(el.value);
      if (out) out.textContent = fmt(settings[key]);
      apply(settings[key]);
      saveSettings();
    });
  };
  const pct = (v) => Math.round(v * 100) + '%';
  bind('#setTrail', 'trail', pct, (v) => (engine.params.trail = v));
  bind('#setBloom', 'bloom', pct, (v) => (engine.params.bloom = v));
  bind('#setExposure', 'exposure', pct, (v) => (engine.params.exposure = v));
  bind('#setSize', 'size', pct, (v) => (engine.params.size = v));
  bind('#setTurb', 'turb', pct, (v) => (engine.params.turb = v));
  bind('#setVolume', 'volume', pct, (v) => audio.setVolume(v));
  $('#setCount').value = String(settings.count);
  $('#setCount').addEventListener('change', (e) => {
    settings.count = +e.target.value;
    settings.userCount = true;
    saveSettings();
    setCount(settings.count);
  });
  $('#setOrbit').checked = settings.orbit;
  $('#setOrbit').addEventListener('change', (e) => { settings.orbit = e.target.checked; saveSettings(); });
  $('#btnReset').addEventListener('click', () => {
    Object.assign(settings, DEFAULTS);
    saveSettings();
    Object.assign(engine.params, { trail: settings.trail, bloom: settings.bloom, turb: settings.turb, exposure: settings.exposure, size: settings.size });
    audio.setVolume(settings.volume);
    ['Trail', 'Bloom', 'Exposure', 'Size', 'Turb', 'Volume'].forEach((k) => {
      const key = k.toLowerCase();
      $('#set' + k).value = settings[key];
      $('#o' + k).textContent = pct(settings[key]);
    });
    $('#setCount').value = String(settings.count);
    $('#setOrbit').checked = settings.orbit;
    setCount(settings.count);
    toast('기본값으로 되돌렸어요');
  });

  // ------------------------------------------------------------ intro
  function start(withSound) {
    if (started) return;
    started = true;
    if (withSound) { audio.init(); audio.setMuted(false); }
    syncSoundIcon();
    $('#intro').classList.add('gone');
    document.body.classList.remove('booting');
    showText('LUMEN', { fromTour: true });
    setTimeout(() => {
      if (lastSource && lastSource.type === 'text' && lastSource.value === 'LUMEN') {
        setTour(true);
        tour.idx = 0;
        tour.next = time;
      }
    }, 5200);
    setTimeout(cycleHints, 2500);
    armIdle();
  }
  $('#startSound').addEventListener('click', () => start(true));
  $('#startSilent').addEventListener('click', () => start(false));

  // ------------------------------------------------------------ pointer input
  function pointerNDC(x, y) {
    const r = canvas.getBoundingClientRect();
    return [((x - r.left) / r.width) * 2 - 1, -(((y - r.top) / r.height) * 2 - 1)];
  }
  function rayFrom(x, y) {
    const [nx, ny] = pointerNDC(x, y);
    const b = cam.basis;
    const t = Math.tan(cam.fov / 2);
    const aspect = engine.W / engine.H;
    const d = V.norm(V.add(V.add(b.forward, V.scale(b.right, nx * t * aspect)), V.scale(b.up, ny * t)));
    return { o: cam.eye, d };
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    closePanels();
    if (touches.size === 2) {
      // second finger: switch to orbit / pinch, cancel the black hole
      endHold(false);
      ptr.down = false;
      const [a, b] = [...touches.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: cam.zoom, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      return;
    }
    if (touches.size > 2) return;
    ptr.x = e.clientX; ptr.y = e.clientY; ptr.inside = true;
    ptr.down = true;
    ptr.downT = performance.now();
    ptr.downX = e.clientX; ptr.downY = e.clientY;
    ptr.lastMoveT = e.timeStamp;
    ptr.stroke = false;
    ptr.touch = e.pointerType !== 'mouse';
    ptr.orbit = e.button === 2 || e.button === 1 || e.ctrlKey || e.shiftKey || e.metaKey;
  });
  canvas.addEventListener('pointermove', (e) => {
    const t = touches.get(e.pointerId);
    if (t) { t.x = e.clientX; t.y = e.clientY; }
    if (pinch && touches.size >= 2) {
      const [a, b] = [...touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      cam.zoom = U.clamp(pinch.zoom * (pinch.d / Math.max(d, 1)), 0.35, 2.4);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      orbitBy(cx - pinch.cx, cy - pinch.cy);
      pinch.cx = cx; pinch.cy = cy;
      return;
    }
    const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y;
    const dtE = Math.max(e.timeStamp - ptr.lastMoveT, 4) / 1000;
    ptr.lastMoveT = e.timeStamp;
    ptr.x = e.clientX; ptr.y = e.clientY; ptr.inside = true;
    ptr.touch = e.pointerType !== 'mouse';
    if (ptr.down && ptr.orbit) { orbitBy(dx, dy); return; }
    // moving away before the black hole forms makes this press a stroke (stir), not a hold
    if (ptr.down && !ptr.holding && Math.hypot(e.clientX - ptr.downX, e.clientY - ptr.downY) > 14) ptr.stroke = true;
    ptr.accX += dx; ptr.accY += dy;
    wake(Math.hypot(dx, dy) / dtE);
  });
  const release = (e) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    if (!ptr.down) return;
    ptr.down = false;
    if (ptr.orbit) return;
    if (e.pointerType !== 'mouse') ptr.inside = false;
    if (ptr.holding) { endHold(true); return; }
    const moved = Math.hypot(e.clientX - ptr.downX, e.clientY - ptr.downY);
    if (moved < 8 && e.type === 'pointerup') clickAt(e.clientX, e.clientY);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') ptr.inside = false; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.zoom = U.clamp(cam.zoom * Math.exp(e.deltaY * 0.0012), 0.35, 2.4);
  }, { passive: false });

  function orbitBy(dx, dy) {
    cam.tTheta -= dx * 0.006;
    cam.tPhi = U.clamp(cam.tPhi + dy * 0.005, -1.35, 1.35);
  }

  function worldAt(x, y) {
    const r = rayFrom(x, y);
    const f = cam.basis.forward;
    const t = V.dot(V.scale(cam.eye, -1), f) / V.dot(r.d, f);
    return V.add(r.o, V.scale(r.d, t));
  }

  function clickAt(x, y) {
    const p = worldAt(x, y);
    engine.addShock(p, 9, 3.2, 0.28, 1.1, time);
    if (audio.ready) {
      const rect = canvas.getBoundingClientRect();
      audio.pluckAt((x - rect.left) / rect.width, (y - rect.top) / rect.height, 0.8);
    }
  }

  function wake(pxPerSec) {
    // Fast strokes play notes: the screen becomes a harp (hover with a mouse, swipe with a finger).
    if (!audio.ready || ptr.holding) return;
    if (ptr.down && !ptr.stroke) return;
    const now = performance.now();
    const threshold = ptr.touch ? 650 : 1500;
    if (pxPerSec > threshold && now - ptr.lastPluck > 140) {
      ptr.lastPluck = now;
      const rect = canvas.getBoundingClientRect();
      audio.pluckAt((ptr.x - rect.left) / rect.width, (ptr.y - rect.top) / rect.height, Math.min(1, pxPerSec / (threshold * 3)));
    }
  }

  function endHold(explode) {
    if (!ptr.holding) return;
    const h = ptr.hold;
    ptr.holding = false;
    ptr.hold = 0;
    audio.holdEnd();
    if (explode) {
      engine.addShock(ptr.world, 12 + 42 * h, 3.4 + 2.4 * h, 0.35 + 0.35 * h, 1.9, time);
      engine.flash = 0.06 + 0.16 * h;
      audio.boom(0.35 + 0.65 * h);
    }
  }

  function updatePointer(dt) {
    const wpp = (2 * cam.dist * Math.tan(cam.fov / 2)) / canvas.clientHeight;
    const b = cam.basis;
    const vx = (ptr.accX * wpp) / dt, vy = (-ptr.accY * wpp) / dt;
    ptr.accX = ptr.accY = 0;
    const target = V.add(V.scale(b.right, vx), V.scale(b.up, vy));
    const k = 0.35;
    ptr.vel = V.add(V.scale(ptr.vel, 1 - k), V.scale(target, k));
    const sp = V.len(ptr.vel);
    if (sp > 18) ptr.vel = V.scale(ptr.vel, 18 / sp);
    audio.energy = Math.min(1, audio.energy + sp * dt * 0.02);

    // black hole grows only while the primary pointer is held (nearly) still
    if (ptr.down && !ptr.orbit && !ptr.stroke && touches.size < 2) {
      const held = (performance.now() - ptr.downT) / 1000;
      const h = U.clamp((held - 0.22) / 1.8, 0, 1);
      if (h > 0 && !ptr.holding) { ptr.holding = true; audio.holdStart(); }
      if (ptr.holding) { ptr.hold = h; audio.holdUpdate(h); }
    }

    let ray = { o: [0, 0, 1e3], d: [0, 0, 1] };
    if (ptr.inside || ptr.down) {
      ray = rayFrom(ptr.x, ptr.y);
      ptr.world = worldAt(ptr.x, ptr.y);
    }
    return {
      rayO: ray.o, rayD: ray.d, pointer: ptr.world,
      pointerVel: ptr.inside ? ptr.vel : [0, 0, 0],
      hold: ptr.holding ? ptr.hold : 0,
    };
  }

  // ------------------------------------------------------------ drag & drop images
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#drop').classList.add('show'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.remove('show'); } });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#drop').classList.remove('show');
    if (!started) start(false);
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadImageFile(f);
  });
  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith('image/'));
    if (item) loadImageFile(item.getAsFile());
  });

  // ------------------------------------------------------------ keyboard
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
      if (e.key === 'Escape') { closePanels(); e.target.blur(); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!started) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); start(true); }
      return;
    }
    const k = e.key.toLowerCase();
    if (k >= '1' && k <= '8') { selectShape(L.SHAPES[+k - 1].id); return; }
    switch (k) {
      case ' ':
        e.preventDefault();
        engine.addShock([0, 0, 0], 45, 5.5, 0.7, 2.2, time);
        engine.flash = 0.2;
        audio.boom(1);
        break;
      case 't': case '9': e.preventDefault(); $('#btnText').click(); break;
      case 'i': case '0': $('#file').click(); break;
      case 'c': $('#btnMirror').click(); break;
      case 'a': setTour(!tour.on); toast(tour.on ? '자동 여행을 시작해요' : '자동 여행을 멈췄어요'); break;
      case 'm': toggleSound(); break;
      case 'h': document.body.classList.toggle('ui-hidden'); break;
      case 'f': toggleFull(); break;
      case 'p': wantShot = true; break;
      case 'r': toggleRecord(); break;
      case '?': case '/': openPanel('#helpPanel'); break;
      case 'escape': closePanels(); break;
      default:
    }
  });

  // ------------------------------------------------------------ idle UI fade
  let idleTimer = 0;
  function armIdle() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!document.querySelector('.panel.open') && started) document.body.classList.add('idle');
    }, 4200);
  }
  ['pointermove', 'pointerdown', 'keydown', 'wheel'].forEach((ev) => window.addEventListener(ev, () => started && armIdle(), { passive: true }));

  // ------------------------------------------------------------ camera
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2);
    const w = Math.max(2, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(canvas.clientHeight * dpr));
    engine.resize(w, h);
  }

  function updateCamera(dt) {
    if (settings.orbit && !cam.front && !(ptr.down && ptr.orbit) && !pinch) cam.tTheta += dt * 0.07;
    const k = U.damp(2.2, dt);
    cam.theta += (cam.tTheta - cam.theta) * k;
    cam.phi += (cam.tPhi - cam.phi) * k;
    const aspect = engine.W / engine.H;
    // keep shapes inside narrow (portrait) screens; flat front-facing ones are widest
    const fit = Math.max(1, (cam.front ? 1.3 : 1.05) / aspect);
    cam.dist += (cam.baseDist * fit * cam.zoom - cam.dist) * U.damp(1.8, dt);
    let th = cam.theta, ph = cam.phi;
    if (cam.front) { th += Math.sin(time * 0.33) * 0.17; ph += Math.sin(time * 0.23) * 0.06; }
    const d = cam.dist;
    cam.eye = [Math.sin(th) * Math.cos(ph) * d, Math.sin(ph) * d, Math.cos(th) * Math.cos(ph) * d];
    M.perspective(cam.proj, cam.fov, aspect, 0.05, 200);
    cam.basis = M.lookAt(cam.view, cam.eye, [0, 0, 0], [0, 1, 0]);
  }

  // ------------------------------------------------------------ frame loop
  let last = performance.now() / 1000;
  let perfSamples = [];
  let perfChecked = settings.userCount || !!params.get('n');
  let perfDowngrades = 0;

  function onAudioEvent(e) {
    if (e.type === 'note') {
      engine.addShock(engine.randomPoint(), 2.2 + e.vel * 6, 1.5, 0.2, 1.3, time);
    } else if (e.type === 'beat') {
      pulse = Math.max(pulse, e.amp);
    }
  }

  function frame(nowMs) {
    requestAnimationFrame(frame);
    const now = nowMs / 1000;
    const dt = U.clamp(now - last, 0.0005, 1 / 30);
    last = now;
    time += dt;

    resize();
    updateCamera(dt);
    const u = updatePointer(dt);

    const bands = audio.analyse();
    audio.poll(onAudioEvent);
    if (current && current.anim === 2 && !audio.ready) {
      beatClock += dt;
      if (beatClock > 0.79) { beatClock -= 0.79; pulse = 1; setTimeout(() => (pulse = Math.max(pulse, 0.55)), 210); }
    }
    pulse *= Math.exp(-dt * 7);
    engine.flash *= Math.exp(-dt * 5);
    u.pulse = pulse;
    u.bass = audio.micOn ? bands.bass * 1.6 : bands.bass * 0.8;
    u.high = bands.high;

    if (videoStream && current && current.id === 'video') engine.updateVideo(video);

    engine.step(dt, time, u);
    engine.render(cam, time, u);

    if (wantShot) { wantShot = false; saveShot(); }

    if (tour.on && time > tour.next) {
      selectShape(TOUR[tour.idx % TOUR.length], { fromTour: true });
      tour.idx++;
      tour.next = time + 16;
    }

    fpsFrames++;
    fpsTime += now - (frame.prev || now);
    frame.prev = now;
    updateStats();

    // one-time adaptive quality: drop the particle count if the GPU struggles
    if (!perfChecked && started && time > 3) {
      perfSamples.push(now - (frame.prevPerf || now));
      frame.prevPerf = now;
      if (perfSamples.length >= 150) {
        perfChecked = true;
        const sorted = perfSamples.slice().sort((a, b) => a - b);
        const median = sorted[sorted.length >> 1];
        perfSamples = [];
        if (median > 1 / 32 && engine.N > 256) {
          const n = engine.N > 768 ? 768 : engine.N > 512 ? 512 : 256;
          if (++perfDowngrades < 3) perfChecked = false; // measure again at the new size
          settings.count = n;
          $('#setCount').value = String(n);
          setCount(n);
          toast('부드럽게 움직이도록 입자 수를 조정했어요 (설정에서 바꿀 수 있어요)', 4200);
        }
      }
    }
  }

  // initial state: a slowly swirling nebula behind the intro
  resize();
  updateCamera(0.016);
  lastSource = { type: 'shape', id: 'nebula' };
  applyShape(L.SHAPES[0], L.SHAPES[0].gen(engine.N * engine.N), { quiet: true, noCaption: true });
  syncSoundIcon();
  updateStats(true);
  requestAnimationFrame(frame);

  if (params.has('autostart')) start(false);

  // debugging hook
  window.LUMEN.app = { engine, audio, selectShape, showText, showImage, setCount, cam, get time() { return time; } };
})(window.LUMEN);
