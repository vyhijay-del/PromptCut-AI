/* =========================================================
   BEATCUT STUDIO — Core Application (COMPLETE)
   ========================================================= */

const $ = (id) => document.getElementById(id);
const state = {
  audioFile: null,
  audioBuffer: null,
  audioUrl: null,
  analysis: null,          // { duration, bpm, beats, strongBeats, drops, energy }
  clips: [],               // { id, file, url, videoEl, name, duration, width, height }
  timeline: [],            // { clipId, start, duration, effects:{} }
  totalDuration: 0,
  isPlaying: false,
  playStart: 0,
  playOffset: 0,
  animFrame: null,
  recordedBlob: null,
  currentPreviewTime: 0,
};

const canvas = $('previewCanvas');
const ctx = canvas.getContext('2d');
function setCanvasSize(){
  const res = parseInt($('resolution').value);
  canvas.width = res;
  canvas.height = Math.round(res * 16 / 9);
}
setCanvasSize();
$('resolution').addEventListener('change', setCanvasSize);

/* ---------- UI HELPERS ---------- */
function showStatus(el, type, msg){ el.className = 'status show ' + type; el.textContent = msg; }
function clearStatus(el){ el.className = 'status'; el.textContent = ''; }
function fmtTime(s){
  if (!isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

/* ---------- TAB SWITCHING ---------- */
document.querySelectorAll('#clipTabs .tab').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('#clipTabs .tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    const tab = t.dataset.tab;
    $('tabUpload').classList.toggle('hidden', tab !== 'upload');
    $('tabStock').classList.toggle('hidden', tab !== 'stock');
  };
});
let currentCategory = 'cars';
document.querySelectorAll('#categoryTabs .tab').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('#categoryTabs .tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    currentCategory = t.dataset.cat;
  };
});

/* =========================================================
   STEP 1 — AUDIO UPLOAD + WAVEFORM
   ========================================================= */
const audioZone = $('audioZone');
const audioInput = $('audioInput');
const audioPlayer = $('audioPlayer');
const waveformCanvas = $('waveform');

audioZone.addEventListener('click', () => audioInput.click());
audioZone.addEventListener('dragover', e => { e.preventDefault(); audioZone.classList.add('drag'); });
audioZone.addEventListener('dragleave', () => audioZone.classList.remove('drag'));
audioZone.addEventListener('drop', e => {
  e.preventDefault(); audioZone.classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('audio/')) loadAudioFile(f);
});
audioInput.addEventListener('change', e => {
  const f = e.target.files[0];
  if (f) loadAudioFile(f);
});

async function loadAudioFile(file){
  try {
    state.audioFile = file;
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = URL.createObjectURL(file);
    audioPlayer.src = state.audioUrl;
    $('audioName').textContent = file.name;
    $('audioMeta').textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB · ${file.type || 'audio'}`;
    $('audioInfo').classList.remove('hidden');

    // Decode for analysis + waveform
    const arrayBuffer = await file.arrayBuffer();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ac = new AudioCtx();
    state.audioBuffer = await ac.decodeAudioData(arrayBuffer.slice(0));
    ac.close();

    drawWaveform(state.audioBuffer, waveformCanvas);
    $('analyzeBtn').disabled = false;
    clearStatus($('analysisStatus'));
  } catch (err) {
    console.error(err);
    showStatus($('analysisStatus'), 'err', 'Could not decode audio: ' + err.message);
  }
}

function drawWaveform(buffer, cv){
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  cv.width = rect.width * dpr;
  cv.height = 60 * dpr;
  const c = cv.getContext('2d');
  c.scale(dpr, dpr);
  const w = rect.width, h = 60;
  const data = buffer.getChannelData(0);
  const step = Math.ceil(data.length / w);
  const mid = h / 2;
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#d4af37';
  for (let i = 0; i < w; i++){
    let min = 1, max = -1;
    for (let j = 0; j < step; j++){
      const v = data[i * step + j] || 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = mid + min * mid;
    const y2 = mid + max * mid;
    c.fillRect(i, y1, 1, Math.max(1, y2 - y1));
  }
}

$('audioRemove').onclick = () => {
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.audioFile = null; state.audioBuffer = null; state.analysis = null; state.audioUrl = null;
  audioPlayer.removeAttribute('src');
  $('audioInfo').classList.add('hidden');
  $('analysisStats').classList.add('hidden');
  $('analyzeBtn').disabled = true;
  $('generateBtn').disabled = true;
  clearStatus($('analysisStatus'));
};

/* =========================================================
   STEP 1b — BEAT DETECTION (energy-peak)
   ========================================================= */
$('analyzeBtn').onclick = () => {
  if (!state.audioBuffer) return;
  showStatus($('analysisStatus'), 'info', 'Analyzing beats…');
  // Yield to UI
  setTimeout(() => {
    try {
      const res = analyzeBeats(state.audioBuffer);
      state.analysis = res;
      $('statDuration').textContent = fmtTime(res.duration);
      $('statBpm').textContent = res.bpm;
      $('statBeats').textContent = res.beats.length;
      $('statDrops').textContent = res.drops.length;
      $('analysisStats').classList.remove('hidden');
      showStatus($('analysisStatus'), 'ok', `Analysis complete — ${res.beats.length} beats, ~${res.bpm} BPM.`);
      $('generateBtn').disabled = false;
    } catch (err) {
      console.error(err);
      showStatus($('analysisStatus'), 'err', 'Analysis failed: ' + err.message);
    }
  }, 50);
};

function analyzeBeats(buffer){
  const sampleRate = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const duration = buffer.duration;

  // Low-pass-ish energy envelope: use RMS in ~1024-sample windows
  const winSize = 1024;
  const hop = 512;
  const env = [];
  for (let i = 0; i + winSize < data.length; i += hop){
    let sum = 0;
    for (let j = 0; j < winSize; j++) sum += data[i + j] * data[i + j];
    env.push(Math.sqrt(sum / winSize));
  }
  const envRate = sampleRate / hop; // frames per second

  // Normalize
  const maxEnv = Math.max(...env, 1e-6);
  const norm = env.map(v => v / maxEnv);

  // Onset detection: positive difference + local average threshold
  const diff = norm.map((v, i) => i === 0 ? 0 : Math.max(0, v - norm[i - 1]));
  const avgWin = Math.floor(envRate * 0.15); // 150 ms
  const onsets = [];
  for (let i = 0; i < diff.length; i++){
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - avgWin); j <= Math.min(diff.length - 1, i + avgWin); j++){
      sum += diff[j]; cnt++;
    }
    const localAvg = sum / cnt;
    if (diff[i] > localAvg * 1.6 && diff[i] > 0.08){
      onsets.push(i / envRate);
    }
  }

  // Merge close onsets (< 120 ms apart)
  const merged = [];
  for (const t of onsets){
    if (merged.length === 0 || t - merged[merged.length - 1] > 0.12) merged.push(t);
  }

  // Estimate BPM via inter-onset intervals (mode-ish)
  const ioi = [];
  for (let i = 1; i < merged.length; i++) ioi.push(merged[i] - merged[i - 1]);
  ioi.sort((a, b) => a - b);
  let bpm = 120;
  if (ioi.length > 5){
    const med = ioi[Math.floor(ioi.length / 2)];
    if (med > 0){
      let candidate = 60 / med;
      while (candidate < 70) candidate *= 2;
      while (candidate > 180) candidate /= 2;
      bpm = Math.round(candidate);
    }
  }

  // Strong beats: onsets with high local energy (above 75th percentile)
  const energies = merged.map(t => {
    const idx = Math.floor(t * envRate);
    let peak = 0;
    for (let k = Math.max(0, idx - 3); k <= Math.min(norm.length - 1, idx + 3); k++){
      if (norm[k] > peak) peak = norm[k];
    }
    return peak;
  });
  const sortedE = [...energies].sort((a, b) => a - b);
  const p75 = sortedE[Math.floor(sortedE.length * 0.75)] || 0;
  const strongBeats = merged.filter((_, i) => energies[i] >= p75);

  // Drops: strong beats where energy jumps notably vs previous 2s average
  const drops = [];
  let lastDrop = -10;
  for (let i = 0; i < merged.length; i++){
    const t = merged[i];
    const idx = Math.floor(t * envRate);
    const win = Math.floor(envRate * 2);
    let prevAvg = 0, cnt = 0;
    for (let k = Math.max(0, idx - win); k < Math.max(1, idx - 3); k++){ prevAvg += norm[k]; cnt++; }
    prevAvg = cnt ? prevAvg / cnt : 0;
    if (norm[idx] > prevAvg * 1.8 && energies[i] >= p75 && t - lastDrop > 3){
      drops.push(t);
      lastDrop = t;
    }
  }

  return {
    duration,
    bpm,
    beats: merged,
    strongBeats,
    drops,
    envRate,
    energy: norm,
  };
}

/* =========================================================
   STEP 2 — VIDEO CLIPS
   ========================================================= */
const videoZone = $('videoZone');
const videoInput = $('videoInput');
const clipListEl = $('clipList');

videoZone.addEventListener('click', () => videoInput.click());
videoZone.addEventListener('dragover', e => { e.preventDefault(); videoZone.classList.add('drag'); });
videoZone.addEventListener('dragleave', () => videoZone.classList.remove('drag'));
videoZone.addEventListener('drop', e => {
  e.preventDefault(); videoZone.classList.remove('drag');
  handleVideoFiles(e.dataTransfer.files);
});
videoInput.addEventListener('change', e => handleVideoFiles(e.target.files));

async function handleVideoFiles(files){
  for (const f of files){
    if (!f.type.startsWith('video/')) continue;
    await addClipFromFile(f);
  }
  refreshGenerateBtn();
}

function addClipFromFile(file){
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.src = url;
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      const clip = {
        id: 'clip_' + Math.random().toString(36).slice(2, 9),
        file,
        url,
        videoEl: v,
        name: file.name,
        duration: v.duration || 0,
        width: v.videoWidth,
        height: v.videoHeight,
      };
      state.clips.push(clip);
      renderClipList();
      resolve(clip);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
  });
}

function renderClipList(){
  clipListEl.innerHTML = '';
  state.clips.forEach(clip => {
    const item = document.createElement('div');
    item.className = 'clip-item';
    item.innerHTML = `
      <video src="${clip.url}" muted playsinline preload="metadata"></video>
      <div class="clip-info">
        <div class="name">${clip.name}</div>
        <div class="meta">${fmtTime(clip.duration)} · ${clip.width}×${clip.height}</div>
      </div>
      <button class="clip-remove" title="Remove">✕</button>
    `;
    item.querySelector('.clip-remove').onclick = () => removeClip(clip.id);
    clipListEl.appendChild(item);
  });
}

function removeClip(id){
  const i = state.clips.findIndex(c => c.id === id);
  if (i === -1) return;
  URL.revokeObjectURL(state.clips[i].url);
  state.clips.splice(i, 1);
  renderClipList();
  refreshGenerateBtn();
}

function refreshGenerateBtn(){
  $('generateBtn').disabled = !(state.analysis && state.clips.length > 0);
}

/* =========================================================
   STEP 2b — PIXABAY STOCK SEARCH
   ========================================================= */
$('pixabayKey').value = localStorage.getItem('pixabayKey') || '';
$('pixabayKey').addEventListener('change', e => {
  localStorage.setItem('pixabayKey', e.target.value.trim());
});

$('searchStockBtn').onclick = async () => {
  const key = $('pixabayKey').value.trim();
  if (!key){ showStatus($('stockStatus'), 'err', 'Please enter your Pixabay API key.'); return; }
  const q = $('stockQuery').value.trim();
  const query = q || currentCategory;
  showStatus($('stockStatus'), 'info', `Searching "${query}"…`);
  $('stockGrid').innerHTML = '';
  try {
    const url = `https://pixabay.com/api/videos/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&per_page=24&safesearch=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Pixabay returned ${res.status}`);
    const data = await res.json();
    if (!data.hits || data.hits.length === 0){
      showStatus($('stockStatus'), 'warn', 'No videos found. Try a different keyword.');
      return;
    }
    showStatus($('stockStatus'), 'ok', `Found ${data.hits.length} videos.`);
    renderStockGrid(data.hits);
  } catch (err) {
    console.error(err);
    showStatus($('stockStatus'), 'err', 'Search failed: ' + err.message + ' (CORS/network may block Pixabay on some hosts)');
  }
};

function renderStockGrid(hits){
  const grid = $('stockGrid');
  grid.innerHTML = '';
  hits.forEach(hit => {
    const thumb = hit.videos?.medium?.thumbnail || hit.videos?.small?.thumbnail || '';
    const src = hit.videos?.medium?.url || hit.videos?.small?.url || hit.videos?.tiny?.url || '';
    const item = document.createElement('div');
    item.className = 'stock-item';
    item.innerHTML = `
      <img src="${thumb}" alt="${hit.tags || 'stock'}" loading="lazy"/>
      <div class="badge">${hit.duration}s</div>
      <div class="overlay">▶ Preview</div>
    `;
    item.onclick = () => openStockModal(hit, src, thumb);
    grid.appendChild(item);
  });
}

function openStockModal(hit, src, thumb){
  $('stockModalTitle').textContent = hit.tags || 'Stock Video';
  const vid = $('stockModalVideo');
  vid.src = src;
  vid.poster = thumb;
  $('stockModalInfo').textContent = `${hit.duration}s · ${hit.videos?.medium?.width || '?'}×${hit.videos?.medium?.height || '?'} · by ${hit.user}`;
  $('stockModalOpen').href = hit.pageURL || '#';
  $('stockModalDownload').href = src || '#';
  $('stockModal').classList.add('show');
}
$('stockModalClose').onclick = () => {
  $('stockModal').classList.remove('show');
  $('stockModalVideo').pause();
  $('stockModalVideo').removeAttribute('src');
};
$('stockModal').addEventListener('click', e => {
  if (e.target === $('stockModal')) $('stockModalClose').click();
});

/* =========================================================
   STEP 3 — GENERATE TIMELINE
   ========================================================= */
$('generateBtn').onclick = () => {
  if (!state.analysis || state.clips.length === 0) return;
  try {
    buildTimeline();
    renderTimeline();
    $('previewOverlay').style.display = 'none';
    $('playPauseBtn').disabled = false;
    $('regenBtn').disabled = false;
    $('exportBtn').disabled = false;
    showStatus($('generateStatus'), 'ok', `Timeline built: ${state.timeline.length} cuts across ${fmtTime(state.totalDuration)}.`);
    drawPreviewFrame(0);
    state.currentPreviewTime = 0;
    $('playPauseBtn').textContent = '▶ Play';
    state.isPlaying = false;
    if (state.animFrame) cancelAnimationFrame(state.animFrame);
  } catch (err) {
    console.error(err);
    showStatus($('generateStatus'), 'err', 'Generate failed: ' + err.message);
  }
};

$('regenBtn').onclick = () => $('generateBtn').click();

function buildTimeline(){
  const mode = $('editMode').value;
  const effects = $('effectsMix').value;
  const a = state.analysis;
  const dur = a.duration;

  // Choose cut points per mode
  let cutPoints;
  if (mode === 'every'){
    cutPoints = a.beats.slice();
  } else if (mode === 'strong'){
    cutPoints = a.strongBeats.slice();
  } else if (mode === 'fast'){
    // every beat, but subdivide long gaps by inserting midpoints
    cutPoints = a.beats.slice();
    const extra = [];
    for (let i = 1; i < cutPoints.length; i++){
      const gap = cutPoints[i] - cutPoints[i - 1];
      if (gap > 0.6) extra.push(cutPoints[i - 1] + gap / 2);
    }
    cutPoints = cutPoints.concat(extra).sort((x, y) => x - y);
  } else { // cinematic
    // strong beats but ensure minimum 2s per shot
    const raw = a.strongBeats.length > 4 ? a.strongBeats : a.beats;
    cutPoints = [];
    let last = -Infinity;
    for (const t of raw){
      if (t - last >= 2) { cutPoints.push(t); last = t; }
    }
  }

  // Always start at 0 and end at duration
  const points = [0, ...cutPoints.filter(t => t > 0.15 && t < dur - 0.15), dur];
  // Deduplicate/sort
  const sorted = [...new Set(points.map(t => +t.toFixed(3)))].sort((x, y) => x - y);

  const timeline = [];
  let clipIdx = 0;
  for (let i = 0; i < sorted.length - 1; i++){
    const start = sorted[i];
    const end = sorted[i + 1];
    const segDur = end - start;
    if (segDur < 0.05) continue;
    const clip = state.clips[clipIdx % state.clips.length];
    clipIdx++;

    // Pick a random segment within the clip to use (avoid always intro)
    const maxOffset = Math.max(0, clip.duration - segDur);
    const offset = maxOffset > 0 ? Math.random() * maxOffset * 0.5 : 0;

    timeline.push({
      clipId: clip.id,
      start,
      duration: segDur,
      offset,
      effects: pickEffects(effects, i),
    });
  }

  state.timeline = timeline;
  state.totalDuration = dur;
}

function pickEffects(mix, index){
  if (mix === 'none') return {};
  const base = mix === 'subtle' ? 0.4 : mix === 'intense' ? 1.0 : 0.7;
  return {
    zoom: (index % 2 === 0) ? 1 + 0.08 * base : 1 - 0.05 * base,
    flash: (index % 7 === 0) ? 0.6 * base : 0,
    shake: (index % 5 === 0) ? 4 * base : 0,
    colorPulse: (index % 3 === 0) ? 0.15 * base : 0,
    base,
  };
}

/* =========================================================
   STEP 4 — TIMELINE RENDER
   ========================================================= */
function renderTimeline(){
  const track = $('timelineTrack');
  track.innerHTML = '';
  const total = state.totalDuration || 1;
  state.timeline.forEach((seg, i) => {
    const pct = (seg.duration / total) * 100;
    const el = document.createElement('div');
    el.className = 'timeline-clip';
    el.style.flex = `0 0 ${pct}%`;
    el.title = `Cut ${i + 1} · ${seg.duration.toFixed(2)}s`;
    el.textContent = i + 1;
    track.appendChild(el);
  });
  // Beat markers overlay
  const wrap = $('timeline');
  wrap.querySelectorAll('.beat-marker').forEach(n => n.remove());
  const a = state.analysis;
  if (a){
    const wrapW = track.getBoundingClientRect().width || wrap.clientWidth;
    a.strongBeats.forEach(t => {
      if (t > total) return;
      const m = document.createElement('div');
      m.className = 'beat-marker';
      m.style.left = (t / total * wrapW) + 'px';
      wrap.appendChild(m);
    });
  }
  $('timelineInfo').textContent = `${state.timeline.length} cuts · ${fmtTime(total)} · ${a ? a.bpm + ' BPM' : ''}`;
}

/* =========================================================
   STEP 4b — PLAYBACK + RENDER LOOP
   ========================================================= */
$('playPauseBtn').onclick = () => {
  if (state.isPlaying) pausePlayback();
  else startPlayback();
};

function startPlayback(){
  if (!state.timeline.length) return;
  state.isPlaying = true;
  $('playPauseBtn').textContent = '⏸ Pause';
  audioPlayer.currentTime = state.currentPreviewTime;
  audioPlayer.play().catch(() => {});
  state.playStart = performance.now() - state.currentPreviewTime * 1000;
  loop();
}

function pausePlayback(){
  state.isPlaying = false;
  $('playPauseBtn').textContent = '▶ Play';
  audioPlayer.pause();
  if (state.animFrame) cancelAnimationFrame(state.animFrame);
}

function loop(){
  if (!state.isPlaying) return;
  const t = audioPlayer.currentTime;
  state.currentPreviewTime = t;
  if (t >= state.totalDuration || audioPlayer.ended){
    pausePlayback();
    state.currentPreviewTime = 0;
    drawPreviewFrame(0);
    return;
  }
  drawPreviewFrame(t);
  state.animFrame = requestAnimationFrame(loop);
}

audioPlayer.addEventListener('seeked', () => {
  if (!state.isPlaying) drawPreviewFrame(audioPlayer.currentTime);
});

function findSegment(t){
  for (const seg of state.timeline){
    if (t >= seg.start && t < seg.start + seg.duration) return seg;
  }
  return state.timeline[state.timeline.length - 1] || null;
}

function drawPreviewFrame(t){
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const seg = findSegment(t);
  if (!seg) return;
  const clip = state.clips.find(c => c.id === seg.clipId);
  if (!clip) return;

  const v = clip.videoEl;
  const local = t - seg.start;
  const targetTime = Math.min(clip.duration - 0.05, seg.offset + local);
  // Only set currentTime if diverged significantly (avoid thrash)
  if (Math.abs(v.currentTime - targetTime) > 0.25 || v.paused){
    try { v.currentTime = Math.max(0, targetTime); } catch (e) {}
  }

  // Cover-fit draw
  const cw = canvas.width, ch = canvas.height;
  const vw = v.videoWidth || clip.width || 1;
  const vh = v.videoHeight || clip.height || 1;
  const scale = Math.max(cw / vw, ch / vh);
  const dw = vw * scale, dh = vh * scale;
  const dx = (cw - dw) / 2, dy = (ch - dh) / 2;

  // Effects: zoom, shake
  const fx = seg.effects || {};
  const progress = seg.duration ? local / seg.duration : 0;
  let zoom = fx.zoom || 1;
  // Animate zoom across the cut
  zoom = zoom * (1 + (progress - 0.5) * 0.06);
  const shake = fx.shake || 0;
  const sx = (Math.random() - 0.5) * shake;
  const sy = (Math.random() - 0.5) * shake;

  ctx.save();
  ctx.translate(cw / 2 + sx, ch / 2 + sy);
  ctx.scale(zoom, zoom);
  ctx.translate(-cw / 2, -ch / 2);
  try {
    ctx.drawImage(v, dx, dy, dw, dh);
  } catch (e) {}
  ctx.restore();

  // Flash effect on first frames of a cut
  if (fx.flash && local < 0.08){
    const a = fx.flash * (1 - local / 0.08);
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.fillRect(0, 0, cw, ch);
  }
  // Color pulse
  if (fx.colorPulse){
    const a = fx.colorPulse * Math.abs(Math.sin(progress * Math.PI));
    ctx.fillStyle = `rgba(212,175,55,${a})`;
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillRect(0, 0, cw, ch);
    ctx.globalCompositeOperation = 'source-over';
  }

  // Beat-marker pulse (global)
  const a = state.analysis;
  if (a){
    for (const bt of a.strongBeats){
      if (Math.abs(bt - t) < 0.06){
        const fade = 1 - Math.abs(bt - t) / 0.06;
        ctx.fillStyle = `rgba(212,175,55,${0.18 * fade})`;
        ctx.fillRect(0, 0, cw, ch);
        break;
      }
    }
  }
}

/* =========================================================
   STEP 5 — EXPORT VIA MEDIARECORDER
   ========================================================= */
$('exportBtn').onclick = async () => {
  if (!state.timeline.length) return;
  const statusEl = $('exportStatus');
  const progWrap = $('exportProgress');
  const bar = $('exportBar');
  $('exportDownload').classList.add('hidden');
  clearStatus(statusEl);
  if (state.recordedBlob){ URL.revokeObjectURL(state.recordedBlob); state.recordedBlob = null; }

  // Pick supported mime
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  const mime = candidates.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  if (!mime){
    showStatus(statusEl, 'err', 'MediaRecorder not supported on this browser.');
    return;
  }

  // We render into an offscreen canvas at the chosen resolution.
  const res = parseInt($('resolution').value);
  const outW = res, outH = Math.round(res * 16 / 9);
  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW; outCanvas.height = outH;
  const octx = outCanvas.getContext('2d');

  // Stream from canvas
  const stream = outCanvas.captureStream(30);
  // Optional: mix audio in
  let audioStream = null;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ac = new AudioCtx();
    const src = ac.createMediaElementSource(audioPlayer);
    const dest = ac.createMediaStreamDestination();
    src.connect(dest);
    src.connect(ac.destination);
    audioStream = dest.stream;
    audioStream.getAudioTracks().forEach(tr => stream.addTrack(tr));
  } catch (e){
    console.warn('Audio capture failed, exporting video-only', e);
  }

  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  progWrap.classList.remove('hidden');
  bar.style.width = '0%';
  showStatus(statusEl, 'info', 'Recording… keep this tab in focus.');

  // Restart audio from 0
  audioPlayer.currentTime = 0;
  try { await audioPlayer.play(); } catch (e) {}

  rec.start(200);
  const total = state.totalDuration;
  const startTs = performance.now();

  // Render loop for export
  await new Promise(resolve => {
    function tick(){
      const t = audioPlayer.currentTime;
      const progress = Math.min(1, t / total);
      bar.style.width = (progress * 100).toFixed(1) + '%';

      // Draw frame into outCanvas
      octx.fillStyle = '#000';
      octx.fillRect(0, 0, outW, outH);
      const seg = findSegment(t);
      if (seg){
        const clip = state.clips.find(c => c.id === seg.clipId);
        if (clip){
          const v = clip.videoEl;
          const local = t - seg.start;
          const target = Math.min(clip.duration - 0.05, seg.offset + local);
          if (Math.abs(v.currentTime - target) > 0.25 || v.paused){
            try { v.currentTime = Math.max(0, target); } catch (e) {}
          }
          const vw = v.videoWidth || clip.width || 1;
          const vh = v.videoHeight || clip.height || 1;
          const scale = Math.max(outW / vw, outH / vh);
          const dw = vw * scale, dh = vh * scale;
          const dx = (outW - dw) / 2, dy = (outH - dh) / 2;
          const fx = seg.effects || {};
          const progress2 = seg.duration ? local / seg.duration : 0;
          const zoom = (fx.zoom || 1) * (1 + (progress2 - 0.5) * 0.06);
          const shake = fx.shake || 0;
          octx.save();
          octx.translate(outW / 2 + (Math.random() - 0.5) * shake,
                         outH / 2 + (Math.random() - 0.5) * shake);
          octx.scale(zoom, zoom);
          octx.translate(-outW / 2, -outH / 2);
          try { octx.drawImage(v, dx, dy, dw, dh); } catch (e) {}
          octx.restore();
          if (fx.flash && local < 0.08){
            const a = fx.flash * (1 - local / 0.08);
            octx.fillStyle = `rgba(255,255,255,${a})`;
            octx.fillRect(0, 0, outW, outH);
          }
          if (fx.colorPulse){
            const a = fx.colorPulse * Math.abs(Math.sin(progress2 * Math.PI));
            octx.fillStyle = `rgba(212,175,55,${a})`;
            octx.globalCompositeOperation = 'overlay';
            octx.fillRect(0, 0, outW, outH);
            octx.globalCompositeOperation = 'source-over';
          }
        }
      }
      // Beat flashes
      if (state.analysis){
        for (const bt of state.analysis.strongBeats){
          if (Math.abs(bt - t) < 0.06){
            const fade = 1 - Math.abs(bt - t) / 0.06;
            octx.fillStyle = `rgba(212,175,55,${0.18 * fade})`;
            octx.fillRect(0, 0, outW, outH);
            break;
          }
        }
      }

      if (t >= total - 0.05 || audioPlayer.ended){
        bar.style.width = '100%';
        resolve();
        return;
      }
      // guard against infinite wait
      if (performance.now() - startTs > (total + 30) * 1000){
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });

  // Stop
  rec.stop();
  audioPlayer.pause();
  await new Promise(r => { rec.onstop = r; });

  progWrap.classList.add('hidden');
  const blob = new Blob(chunks, { type: mime });
  state.recordedBlob = URL.createObjectURL(blob);
  const dl = $('downloadLink');
  dl.href = state.recordedBlob;
  dl.download = 'beatcut-' + Date.now() + '.webm';
  $('exportDownload').classList.remove('hidden');
  showStatus(statusEl, 'ok', `Done! ${(blob.size / 1024 / 1024).toFixed(2)} MB WebM.`);
};

/* =========================================================
   RESET
   ========================================================= */
$('resetBtn').onclick = () => {
  if (!confirm('Reset everything? All uploaded audio and clips will be lost.')) return;

  pausePlayback();
  if (state.animFrame) cancelAnimationFrame(state.animFrame);

  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.clips.forEach(c => URL.revokeObjectURL(c.url));
  if (state.recordedBlob) URL.revokeObjectURL(state.recordedBlob);

  state.audioFile = null;
  state.audioBuffer = null;
  state.audioUrl = null;
  state.analysis = null;
  state.clips = [];
  state.timeline = [];
  state.totalDuration = 0;
  state.currentPreviewTime = 0;
  state.recordedBlob = null;

  audioPlayer.removeAttribute('src');
  $('audioInfo').classList.add('hidden');
  $('analysisStats').classList.add('hidden');
  $('analysisStatus').className = 'status';
  $('generateStatus').className = 'status';
  $('exportStatus').className = 'status';
  $('exportProgress').classList.add('hidden');
  $('exportDownload').classList.add('hidden');

  $('analyzeBtn').disabled = true;
  $('generateBtn').disabled = true;
  $('playPauseBtn').disabled = true;
  $('playPauseBtn').textContent = '▶ Play';
  $('regenBtn').disabled = true;
  $('exportBtn').disabled = true;

  clipListEl.innerHTML = '';
  $('timelineTrack').innerHTML = '';
  $('timelineInfo').textContent = '—';
  $('previewOverlay').style.display = 'flex';
  $('stockGrid').innerHTML = '';
  $('stockStatus').className = 'status';

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
};

/* =========================================================
   INITIAL PREVIEW RESET
   ========================================================= */
ctx.fillStyle = '#000';
ctx.fillRect(0, 0, canvas.width, canvas.height);

window.addEventListener('beforeunload', () => {
  state.clips.forEach(c => URL.revokeObjectURL(c.url));
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  if (state.recordedBlob) URL.revokeObjectURL(state.recordedBlob);
});
