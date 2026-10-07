'use strict';

const VIDEO_EXT = /\.(mkv|webm|mp4|m4v|mov|avi|ts|ogv|y4m)$/i;
const SAMPLE_MS = 500;      // metric refresh interval
const SYNC_MS = 200;        // sync-check interval
const SOFT_SYNC_S = 0.02;   // below this a stream counts as in sync
const HARD_SYNC_S = 0.5;    // above this, correct by seeking instead of nudging
const MAX_NUDGE = 0.08;     // max playback-rate trim used to pull a stream back
const SEEK_SETTLE_MS = 400; // ignore drift right after a seek
const START_TIMEOUT_MS = 20000;
const HISTORY_POINTS = 240; // ~2 min of aggregate-FPS history
const MAX_INTERVALS = 120;  // frame-interval samples kept per stream

// Gives real presented-frame timing; without it we fall back to decoded-frame counters.
const HAS_RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

const $ = (id) => document.getElementById(id);

const ui = {
  filePicker: $('filePicker'),
  folderPicker: $('folderPicker'),
  clearBtn: $('clearBtn'),
  playBtn: $('playBtn'),
  pauseBtn: $('pauseBtn'),
  restartBtn: $('restartBtn'),
  exportBtn: $('exportBtn'),
  replicas: $('replicas'),
  columns: $('columns'),
  rate: $('rate'),
  loopToggle: $('loopToggle'),
  muteToggle: $('muteToggle'),
  overlayToggle: $('overlayToggle'),
  fitToggle: $('fitToggle'),
  syncToggle: $('syncToggle'),
  timeline: $('timeline'),
  timeLabel: $('timeLabel'),
  driftLabel: $('driftLabel'),
  stepBack: $('stepBack'),
  stepFwd: $('stepFwd'),
  grid: $('grid'),
  empty: $('empty'),
  notice: $('notice'),
  tbody: $('statsBody'),
  tableCount: $('tableCount'),
  chart: $('chart'),
  mStreams: $('mStreams'),
  mStreamsSub: $('mStreamsSub'),
  mMinFps: $('mMinFps'),
  mMinSub: $('mMinSub'),
  mGlobalMin: $('mGlobalMin'),
  mGlobalMinSub: $('mGlobalMinSub'),
  mAvgFps: $('mAvgFps'),
  mAvgSub: $('mAvgSub'),
  mDropped: $('mDropped'),
  mDroppedSub: $('mDroppedSub'),  mThroughput: $('mThroughput'),
  mThroughputSub: $('mThroughputSub'),
  mDrift: $('mDrift'),
  mDriftSub: $('mDriftSub'),
  mUiFps: $('mUiFps'),
  mElapsed: $('mElapsed'),
  engine: $('engine'),
};

const state = {
  streams: [],
  nextId: 1,
  history: [],
  globalMin: Infinity,
  drift: 0,
  scrubbing: false,
  userPaused: false,
  seekSettleUntil: 0,
  lastSync: 0,
  startedAt: null,
  uiFrames: 0,
  lastUiSample: performance.now(),
  lastSample: performance.now(),
};

/* ---------------- source preparation ---------------- */

// Containers browsers reliably decode. canPlayType is not usable here: Chromium
// answers "maybe" for video/x-matroska and then fails on the actual decode.
const BROWSER_SAFE_EXT = /\.(mp4|m4v|mov|webm|ogv)$/i;

let converterReady = null;
let originPool = null;

function playableInBrowser(file) {
  return BROWSER_SAFE_EXT.test(file.name);
}

function serverInfo() {
  if (!converterReady) {
    converterReady = fetch('api/health').then((r) => r.json()).catch(() => ({}));
  }
  return converterReady;
}

async function hasConverter() {
  return !!(await serverInfo()).ffmpeg;
}

// A playing <video> holds an HTTP connection, and browsers allow only ~6 per
// origin, so 12 tiles on one port starve. Extra ports lift that ceiling, but
// only the ones that actually answer: a port-forward may expose just the first.
async function reachableOrigins() {
  if (originPool) return originPool;

  const here = location.origin;
  const { shards = [] } = await serverInfo();
  const others = shards
    .map((port) => `${location.protocol}//${location.hostname}:${port}`)
    .filter((origin) => origin !== here);

  const probed = await Promise.all(others.map(async (origin) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 1500);
    try {
      return (await fetch(`${origin}/api/health`, { signal: abort.signal })).ok ? origin : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }));

  originPool = [here, ...probed.filter(Boolean)];
  return originPool;
}

async function convertFile(file) {
  const res = await fetch('api/convert', {
    method: 'POST',
    headers: { 'X-Filename': encodeURIComponent(file.name) },
    body: file,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return (await res.json()).url;
}

// Returns a playable source per file, converting through the helper when needed.
async function resolveSources(files) {
  const needWork = files.filter((f) => !playableInBrowser(f));
  const canConvert = needWork.length ? await hasConverter() : false;

  if (needWork.length && !canConvert) {
    notify(`${needWork.length} file(s) need conversion — start ./server.py, or run ./prepare.sh first.`, 'warn');
  } else if (needWork.length) {
    notify(`Converting ${needWork.length} file(s) the browser cannot decode…`);
  }

  const sources = new Array(files.length);
  const queue = files.map((file, index) => ({ file, index }));
  const origins = canConvert ? await reachableOrigins() : [location.origin];
  let done = 0;

  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const { file, index } = job;
      if (playableInBrowser(file) || !canConvert) {
        sources[index] = { name: file.name, file };
        continue;
      }
      try {
        const path = await convertFile(file);
        sources[index] = { name: file.name, url: origins[index % origins.length] + path };
      } catch (err) {
        notify(`${file.name}: ${err.message}`, 'warn');
        sources[index] = { name: file.name, file };
      }
      notify(`Converted ${++done}/${needWork.length}…`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
  return sources;
}

function notify(text, kind) {
  ui.notice.textContent = text;
  ui.notice.className = `notice ${kind || ''}`;
}

function clearNotice() {
  ui.notice.className = 'notice hidden';
}

/* ---------------- stream creation ---------------- */

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => VIDEO_EXT.test(f.name));
  if (!files.length) return;

  const replicas = clamp(parseInt(ui.replicas.value, 10) || 1, 1, 32);
  const sources = await resolveSources(files);

  for (const src of sources) {
    for (let r = 0; r < replicas; r++) addStream(src, replicas > 1 ? r + 1 : 0);
  }

  ui.empty.classList.add('hidden');
  syncGridColumns();
  notify(`Buffering ${state.streams.length} stream(s)…`);
  await startWhenReady();
  clearNotice();
}

// Starting only once every stream is buffered keeps the first frames aligned.
async function startWhenReady() {
  const pending = state.streams.filter((s) => s.stats.status !== 'error');
  pending.forEach((s) => setStatus(s, 'preparing'));

  await Promise.race([
    Promise.all(pending.map(whenReady)),
    new Promise((resolve) => setTimeout(resolve, START_TIMEOUT_MS)),
  ]);

  seekAll(0);
  playAll();
  state.startedAt = performance.now();
  state.history.length = 0;
  state.globalMin = Infinity;
}

function whenReady(stream) {
  const v = stream.video;
  if (v.readyState >= 3) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      v.removeEventListener('canplaythrough', done);
      v.removeEventListener('error', done);
      resolve();
    };
    v.addEventListener('canplaythrough', done);
    v.addEventListener('error', done);
  });
}

function addStream(source, replicaIndex) {
  const id = state.nextId++;
  const label = replicaIndex ? `${source.name} #${replicaIndex}` : source.name;

  const card = document.createElement('article');
  card.className = 'card';
  card.innerHTML = `
    <div class="video-wrap">
      <video playsinline preload="auto" disablepictureinpicture></video>
      <div class="overlay"></div>
      <button class="remove" type="button" title="Remove this video">×</button>
      <div class="fail"><span class="msg"></span><small>Convert it with <code>./prepare.sh</code> — browsers decode MP4/H.264 and WebM, not every .mkv.</small></div>
    </div>
    <footer class="card-foot">
      <span class="name"></span>
      <span class="badge">loading</span>
    </footer>`;

  const video = card.querySelector('video');
  const row = document.createElement('tr');
  row.innerHTML = '<td></td>' + '<td></td>'.repeat(8);

  const stream = {
    id,
    file: source.file,
    label,
    video,
    card,
    row,
    overlayFps: card.querySelector('.overlay'),
    badge: card.querySelector('.badge'),
    failMsg: card.querySelector('.fail .msg'),
    stats: {
      status: 'loading',
      width: 0,
      height: 0,
      duration: 0,
      presented: 0,
      decoded: 0,
      skipped: 0,
      fps: 0,
      sourceFps: 0,
      lastCounter: 0,
      lastMediaTime: null,
      intervals: [],
      pending: [],
      stalls: 0,
      error: '',
    },
  };

  card.querySelector('.name').textContent = label;
  card.querySelector('.name').title = label;
  row.cells[0].textContent = label;

  video.muted = ui.muteToggle.checked;
  video.loop = ui.loopToggle.checked && !ui.syncToggle.checked;
  video.playbackRate = parseFloat(ui.rate.value);
  // Replicas of a local file need separate object URLs to buffer independently.
  stream.url = source.file ? URL.createObjectURL(source.file) : null;
  video.src = stream.url || source.url;

  wireEvents(stream);
  wireCardControls(stream);
  state.streams.push(stream);
  ui.grid.appendChild(card);
  ui.tbody.appendChild(row);
}

/* ---------------- card arrangement ---------------- */

// Pointer events rather than HTML5 drag-and-drop: the native drag gesture is
// swallowed by the <video> and cannot be driven reliably.
const DRAG_THRESHOLD_PX = 6;
let drag = null;

function wireCardControls(stream) {
  const { card } = stream;

  card.querySelector('.remove').addEventListener('click', (e) => {
    e.stopPropagation();
    removeStream(stream);
  });

  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.remove')) return;
    drag = { stream, startX: e.clientX, startY: e.clientY, active: false };
    card.setPointerCapture(e.pointerId);
  });

  card.addEventListener('pointermove', (e) => {
    if (!drag || drag.stream !== stream) return;

    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
      drag.active = true;
      card.classList.add('dragging');
    }

    clearDropMarkers();
    drag.pending = null;

    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.card');
    if (!over || over === card) return;
    const target = state.streams.find((s) => s.card === over);
    if (!target) return;

    const box = over.getBoundingClientRect();
    const before = e.clientX < box.left + box.width / 2;
    over.classList.add(before ? 'drop-before' : 'drop-after');
    drag.pending = { targetId: target.id, before };
  });

  const endDrag = (e) => {
    if (!drag || drag.stream !== stream) return;
    if (card.hasPointerCapture(e.pointerId)) card.releasePointerCapture(e.pointerId);
    // Commit once on release; reordering during the sweep shuffles everything it passes.
    if (drag.active && drag.pending) {
      moveStream(stream.id, drag.pending.targetId, drag.pending.before);
    }
    card.classList.remove('dragging');
    clearDropMarkers();
    drag = null;
  };

  card.addEventListener('pointerup', endDrag);
  card.addEventListener('pointercancel', endDrag);
}

function clearDropMarkers() {
  for (const el of ui.grid.querySelectorAll('.drop-before, .drop-after')) {
    el.classList.remove('drop-before', 'drop-after');
  }
}

function moveStream(sourceId, targetId, before) {
  if (sourceId === targetId) return;
  const from = state.streams.findIndex((s) => s.id === sourceId);
  const at = state.streams.findIndex((s) => s.id === targetId);
  if (from < 0 || at < 0) return;

  const next = [...state.streams];
  const [moved] = next.splice(from, 1);
  const target = next.findIndex((s) => s.id === targetId);
  next.splice(before ? target : target + 1, 0, moved);

  // Hovering inside one half of a tile repeats; skip the no-op reshuffle.
  if (next.every((s, i) => s === state.streams[i])) return;
  state.streams = next;

  // appendChild moves existing nodes, so one pass in order re-sorts both views.
  for (const s of state.streams) {
    ui.grid.appendChild(s.card);
    ui.tbody.appendChild(s.row);
  }
}

function removeStream(stream) {
  stream.video.pause();
  stream.video.removeAttribute('src');
  stream.video.load();
  if (stream.url) URL.revokeObjectURL(stream.url);

  stream.card.remove();
  stream.row.remove();
  state.streams = state.streams.filter((s) => s !== stream);

  if (!state.streams.length) {
    ui.empty.classList.remove('hidden');
    state.startedAt = null;
    state.history.length = 0;
    state.globalMin = Infinity;
  }
  applyFit();
}

function wireEvents(stream) {
  const { video, stats } = stream;

  video.addEventListener('loadedmetadata', () => {
    stats.width = video.videoWidth;
    stats.height = video.videoHeight;
    stats.duration = video.duration;
    // Drives tile shape, so a wider grid gives a proportionally taller picture.
    stream.card.style.setProperty('--ar', (video.videoWidth / video.videoHeight).toFixed(4));
    applyFit();
    setStatus(stream, video.paused ? 'paused' : 'playing');
  });

  video.addEventListener('playing', () => setStatus(stream, 'playing'));
  video.addEventListener('pause', () => setStatus(stream, 'paused'));
  video.addEventListener('ended', () => setStatus(stream, 'ended'));
  video.addEventListener('waiting', () => {
    stats.stalls++;
    setStatus(stream, 'buffering');
  });

  video.addEventListener('error', () => {
    const code = video.error ? video.error.code : 0;
    stats.error = ({
      1: 'Loading aborted',
      2: 'Network error',
      3: 'Decode error',
      4: 'Source/codec not supported',
    })[code] || 'Playback failed';
    stream.failMsg.textContent = stats.error;
    stream.card.classList.add('error');
    setStatus(stream, 'error');
  });

  if (HAS_RVFC) {
    const onFrame = (_now, meta) => {
      stats.presented = meta.presentedFrames || stats.presented + 1;
      if (stats.lastMediaTime !== null) {
        const dt = meta.mediaTime - stats.lastMediaTime;
        // Ignore seeks, loop wraps and duplicate presentations.
        if (dt > 0.0005 && dt < 1) {
          stats.intervals.push(dt);
          stats.pending.push(dt);
          if (stats.intervals.length > MAX_INTERVALS) stats.intervals.shift();
        }
      }
      stats.lastMediaTime = meta.mediaTime;
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }
}

function setStatus(stream, status) {
  if (stream.stats.status === 'error' && status !== 'error') return;
  stream.stats.status = status;
  stream.badge.textContent = status;
  stream.badge.className = `badge ${status}`;
}

/* ---------------- metric sampling ---------------- */

function sample(now) {
  const dt = (now - state.lastSample) / 1000;
  if (dt < SAMPLE_MS / 1000) return;
  state.lastSample = now;

  let aggregate = 0;
  let skipped = 0;
  let presented = 0;
  let pixelRate = 0;
  let playing = 0;

  for (const s of state.streams) {
    const st = s.stats;
    const q = s.video.getVideoPlaybackQuality ? s.video.getVideoPlaybackQuality() : null;
    if (q) st.decoded = q.totalVideoFrames;

    const counter = HAS_RVFC ? st.presented : st.decoded;
    st.fps = Math.max(0, (counter - st.lastCounter) / dt);
    st.lastCounter = counter;
    st.sourceFps = estimateSourceFps(st.intervals);

    // A presentation gap wider than one source frame means frames were never shown.
    if (st.sourceFps) {
      const frame = 1 / st.sourceFps;
      for (const gap of st.pending) st.skipped += Math.max(0, Math.round(gap / frame) - 1);
    }
    st.pending.length = 0;

    if (st.status === 'playing') playing++;
    aggregate += st.fps;
    skipped += st.skipped;
    presented += st.presented;
    pixelRate += st.width * st.height * st.fps;

    renderStream(s);
  }

  const live = state.streams.filter((s) => s.stats.status !== 'error');
  const minFps = live.length ? Math.min(...live.map((s) => s.stats.fps)) : 0;
  // Only count the session low once every stream is actually playing, so
  // start-up and buffering do not pin it to zero for the rest of the run.
  if (live.length && live.every((s) => s.stats.status === 'playing')) {
    state.globalMin = Math.min(state.globalMin, minFps);
  }

  state.history.push(minFps);
  if (state.history.length > HISTORY_POINTS) state.history.shift();

  renderDashboard({ aggregate, minFps, skipped, presented, pixelRate, playing });
  drawChart();
}

function estimateSourceFps(intervals) {
  if (intervals.length < 8) return 0;
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const fps = 1 / median;
  const rounded = Math.round(fps);
  return Math.abs(fps - rounded) < 0.2 ? rounded : fps;
}

/* ---------------- synchronization ---------------- */

const liveStreams = () =>
  state.streams.filter((s) => s.stats.status !== 'error' && s.video.readyState >= 1);

// Median is used as the reference clock so one lagging stream cannot drag the group.
function refTime() {
  const times = liveStreams().map((s) => s.video.currentTime).sort((a, b) => a - b);
  return times.length ? times[times.length >> 1] : 0;
}

function maxDuration() {
  return state.streams.reduce(
    (m, s) => (isFinite(s.video.duration) ? Math.max(m, s.video.duration) : m), 0);
}

function medianSourceFps() {
  const fps = state.streams.map((s) => s.stats.sourceFps).filter(Boolean).sort((a, b) => a - b);
  return fps.length ? fps[fps.length >> 1] : 30;
}

function seekAll(time) {
  for (const s of liveStreams()) {
    const dur = isFinite(s.video.duration) ? s.video.duration : time;
    s.video.currentTime = clamp(time, 0, Math.max(0, dur - 0.001));
  }
  state.seekSettleUntil = performance.now() + SEEK_SETTLE_MS;
}

function stepFrames(frames) {
  pauseAll();
  seekAll(refTime() + frames / medianSourceFps());
}

function enforceSync(now) {
  if (now - state.lastSync < SYNC_MS) return;
  state.lastSync = now;

  const live = liveStreams();
  const base = parseFloat(ui.rate.value);

  if (!live.length || !ui.syncToggle.checked) {
    state.drift = 0;
    live.forEach((s) => { if (s.video.playbackRate !== base) s.video.playbackRate = base; });
    return;
  }

  // With sync on, looping is driven here so every stream wraps on the same tick.
  if (live.some((s) => s.video.ended)) {
    seekAll(0);
    if (ui.loopToggle.checked) playAll();
    else pauseAll();
    return;
  }

  if (now < state.seekSettleUntil || state.scrubbing) return;

  // A stream the browser stalled out of playback would otherwise strand the group.
  if (!state.userPaused) {
    live.forEach((s) => { if (s.video.paused && !s.video.ended) s.video.play().catch(() => {}); });
  }

  const ref = refTime();
  let worst = 0;
  for (const s of live) {
    const drift = s.video.currentTime - ref;
    worst = Math.max(worst, Math.abs(drift));

    if (Math.abs(drift) > HARD_SYNC_S) {
      s.video.currentTime = ref;
      s.video.playbackRate = base;
    } else if (Math.abs(drift) > SOFT_SYNC_S) {
      // Trim the rate instead of seeking: it converges without visible stutter.
      s.video.playbackRate = base * (1 + clamp(-drift / 0.5, -MAX_NUDGE, MAX_NUDGE));
    } else if (s.video.playbackRate !== base) {
      s.video.playbackRate = base;
    }
  }
  state.drift = worst;
}

function updateTimeline() {
  const dur = maxDuration();
  if (dur && ui.timeline.max !== String(dur)) ui.timeline.max = String(dur);

  const t = refTime();
  if (!state.scrubbing) ui.timeline.value = String(t);
  ui.timeLabel.textContent = `${fmtTime(t)} / ${fmtTime(dur)}`;

  const ms = state.drift * 1000;
  const off = !ui.syncToggle.checked;
  ui.mDrift.textContent = off ? '-' : ms.toFixed(0);
  ui.mDriftSub.textContent = off ? 'sync lock off' : 'ms, worst stream';
  ui.driftLabel.textContent = off ? 'sync off' : `drift ${ms.toFixed(0)} ms`;
  ui.driftLabel.className = `badge ${off ? '' : ms > SOFT_SYNC_S * 2000 ? 'buffering' : 'playing'}`;
}

/* ---------------- rendering ---------------- */

function renderStream(s) {
  const st = s.stats;
  const res = st.width ? `${st.width}x${st.height}` : '-';
  const ratio = st.sourceFps ? st.fps / st.sourceFps : null;
  const expected = st.presented + st.skipped;
  const skipPct = expected ? (st.skipped / expected) * 100 : 0;

  s.overlayFps.textContent = `${st.fps.toFixed(1)} fps`;

  const c = s.row.cells;
  c[1].textContent = res;
  c[2].textContent = st.duration ? fmtTime(st.duration) : '-';
  c[3].textContent = st.sourceFps ? st.sourceFps.toFixed(2) : '-';
  c[4].textContent = st.fps.toFixed(2);
  c[5].textContent = ratio !== null ? `${(ratio * 100).toFixed(0)}%` : '-';
  c[6].textContent = st.presented || st.decoded;
  c[7].textContent = `${st.skipped} (${skipPct.toFixed(1)}%)`;
  c[8].textContent = st.error || st.status;

  c[5].className = ratio === null ? '' : ratio >= 0.95 ? 'good' : ratio >= 0.8 ? 'warn' : 'bad';
  c[7].className = skipPct < 1 ? 'good' : skipPct < 5 ? 'warn' : 'bad';
  c[8].className = st.status === 'error' ? 'bad' : '';
}

function renderDashboard({ aggregate, minFps, skipped, presented, pixelRate, playing }) {
  const total = state.streams.length;
  const errors = state.streams.filter((s) => s.stats.status === 'error').length;
  const expected = presented + skipped;

  ui.mStreams.textContent = total;
  ui.mStreamsSub.textContent = `${playing} playing${errors ? ` · ${errors} failed` : ''}`;
  ui.mMinFps.textContent = minFps.toFixed(1);
  ui.mMinSub.textContent = 'slowest stream now';
  ui.mGlobalMin.textContent = isFinite(state.globalMin) ? state.globalMin.toFixed(1) : '-';
  ui.mGlobalMinSub.textContent = 'worst seen';
  ui.mAvgFps.textContent = total ? (aggregate / total).toFixed(1) : '0.0';
  ui.mAvgSub.textContent = 'per stream';
  ui.mDropped.textContent = skipped;
  ui.mDroppedSub.textContent = expected ? `${((skipped / expected) * 100).toFixed(2)}% of ${expected}` : '-';
  ui.mThroughput.textContent = (pixelRate / 1e6).toFixed(1);
  ui.mThroughputSub.textContent = 'megapixels / s';
  ui.tableCount.textContent = total;
}

function drawChart() {
  const canvas = ui.chart;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const data = state.history;
  if (data.length < 2) return;

  const max = Math.max(1, ...data) * 1.2;
  const x = (i) => (i / (data.length - 1)) * w;
  const y = (v) => h - (v / max) * (h - 4) - 2;

  ctx.beginPath();
  ctx.moveTo(x(0), y(data[0]));
  data.forEach((v, i) => ctx.lineTo(x(i), y(v)));

  const area = new Path2D();
  area.moveTo(x(0), h);
  data.forEach((v, i) => area.lineTo(x(i), y(v)));
  area.lineTo(x(data.length - 1), h);
  area.closePath();

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(76, 194, 255, .35)');
  grad.addColorStop(1, 'rgba(76, 194, 255, 0)');
  ctx.fillStyle = grad;
  ctx.fill(area);

  ctx.strokeStyle = '#4cc2ff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function tick(now) {
  state.uiFrames++;
  if (now - state.lastUiSample >= 1000) {
    ui.mUiFps.textContent = (state.uiFrames * 1000 / (now - state.lastUiSample)).toFixed(0);
    state.uiFrames = 0;
    state.lastUiSample = now;
  }
  ui.mElapsed.textContent = state.startedAt ? fmtTime((now - state.startedAt) / 1000) : '0:00';
  enforceSync(now);
  updateTimeline();
  sample(now);
  requestAnimationFrame(tick);
}

/* ---------------- controls ---------------- */

function playAll() {
  state.userPaused = false;
  state.streams.forEach((s) => s.video.play().catch(() => {}));
}

function pauseAll() {
  state.userPaused = true;
  state.streams.forEach((s) => s.video.pause());
}

function restartAll() {
  seekAll(0);
  state.history.length = 0;
  state.globalMin = Infinity;
  state.startedAt = performance.now();
  playAll();
}

function clearAll() {
  pauseAll();
  state.streams.forEach((s) => {
    s.video.removeAttribute('src');
    s.video.load();
    if (s.url) URL.revokeObjectURL(s.url);
  });
  state.streams.length = 0;
  state.history.length = 0;
  state.globalMin = Infinity;
  state.drift = 0;
  state.startedAt = null;
  state.nextId = 1;
  ui.grid.innerHTML = '';
  ui.tbody.innerHTML = '';
  ui.empty.classList.remove('hidden');
  renderDashboard({ aggregate: 0, minFps: 0, skipped: 0, presented: 0, pixelRate: 0, playing: 0 });
  drawChart();
}

function exportCsv() {
  const header = ['file', 'resolution', 'duration_s', 'source_fps', 'render_fps',
    'realtime_pct', 'frames_presented', 'frames_skipped', 'stalls', 'status'];
  const rows = state.streams.map((s) => {
    const st = s.stats;
    const ratio = st.sourceFps ? (st.fps / st.sourceFps) * 100 : '';
    return [
      s.label, st.width ? `${st.width}x${st.height}` : '',
      st.duration ? st.duration.toFixed(2) : '',
      st.sourceFps ? st.sourceFps.toFixed(2) : '',
      st.fps.toFixed(2), ratio === '' ? '' : ratio.toFixed(0),
      st.presented || st.decoded, st.skipped, st.stalls, st.error || st.status,
    ].map(csvCell).join(',');
  });

  const blob = new Blob([[header.join(','), ...rows].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `video-stats-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function syncGridColumns() {
  ui.grid.dataset.cols = ui.columns.value;
  applyFit();
}

// Size tiles to the video's own aspect ratio so the picture fills them without
// letterboxing, and so every stream still fits on screen.
function applyFit() {
  const on = ui.fitToggle.checked && state.streams.length > 0;
  ui.grid.classList.toggle('fit', on);
  if (!on) {
    ui.grid.style.removeProperty('--card-w');
    return;
  }

  const GAP = 12;
  const FOOT = 28;
  const cols = parseInt(ui.columns.value, 10) || 1;
  const rows = Math.ceil(state.streams.length / cols);
  const ar = state.streams.reduce(
    (a, s) => (s.stats.width ? s.stats.width / s.stats.height : a), 16 / 9);

  const cellW = (ui.grid.clientWidth - GAP * (cols - 1)) / cols;
  const availH = window.innerHeight - ui.grid.getBoundingClientRect().top - 24;
  const cellH = (availH - GAP * (rows - 1)) / rows - FOOT;

  const width = Math.max(200, Math.min(cellW, Math.max(80, cellH) * ar));
  ui.grid.style.setProperty('--card-w', `${Math.floor(width)}px`);
}

/* ---------------- helpers ---------------- */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fmtTime(seconds) {
  if (!isFinite(seconds)) return '-';
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/* ---------------- wiring ---------------- */

ui.filePicker.addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
ui.folderPicker.addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
ui.playBtn.addEventListener('click', playAll);
ui.pauseBtn.addEventListener('click', pauseAll);
ui.restartBtn.addEventListener('click', restartAll);
ui.clearBtn.addEventListener('click', clearAll);
ui.exportBtn.addEventListener('click', exportCsv);
ui.columns.addEventListener('change', syncGridColumns);
ui.fitToggle.addEventListener('change', applyFit);

ui.loopToggle.addEventListener('change', () => {
  state.streams.forEach((s) => { s.video.loop = ui.loopToggle.checked && !ui.syncToggle.checked; });
});
ui.syncToggle.addEventListener('change', () => {
  state.streams.forEach((s) => { s.video.loop = ui.loopToggle.checked && !ui.syncToggle.checked; });
  if (ui.syncToggle.checked) seekAll(refTime());
});
ui.stepBack.addEventListener('click', () => stepFrames(-1));
ui.stepFwd.addEventListener('click', () => stepFrames(1));
ui.timeline.addEventListener('pointerdown', () => { state.scrubbing = true; });
ui.timeline.addEventListener('input', () => seekAll(parseFloat(ui.timeline.value)));
ui.timeline.addEventListener('change', () => {
  seekAll(parseFloat(ui.timeline.value));
  state.scrubbing = false;
});
ui.muteToggle.addEventListener('change', () => {
  state.streams.forEach((s) => { s.video.muted = ui.muteToggle.checked; });
});
ui.rate.addEventListener('change', () => {
  const rate = parseFloat(ui.rate.value);
  state.streams.forEach((s) => { s.video.playbackRate = rate; });
});
ui.overlayToggle.addEventListener('change', () => {
  ui.grid.classList.toggle('no-overlay', !ui.overlayToggle.checked);
});

window.addEventListener('dragover', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  document.body.classList.remove('dragging');
  if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); state.streams.some((s) => !s.video.paused) ? pauseAll() : playAll(); }
  if (e.key === 'ArrowRight') { e.preventDefault(); stepFrames(e.shiftKey ? 10 : 1); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); stepFrames(e.shiftKey ? -10 : -1); }
  if (e.key.toLowerCase() === 'r') restartAll();
});

window.addEventListener('resize', () => {
  drawChart();
  applyFit();
});

ui.engine.textContent = HAS_RVFC
  ? 'frame-accurate metrics (requestVideoFrameCallback)'
  : 'approximate metrics (decoded-frame counters)';

requestAnimationFrame(tick);
