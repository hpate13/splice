/* ===================== Splice — app.js ===================== */
(() => {
'use strict';

/* ---------- DSP helpers shared with the worker (kept inline so the
   worker can be spun up from a Blob without a second file fetch) ---------- */
const DSP_SOURCE = `
function estimateBPM(mono, sampleRate, minBPM, maxBPM) {
  minBPM = minBPM || 70; maxBPM = maxBPM || 185;
  const frameRate = 200;
  const hop = Math.round(sampleRate / frameRate);
  const numFrames = Math.floor(mono.length / hop);
  const energy = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    let sum = 0;
    const start = i * hop;
    const end = Math.min(start + hop, mono.length);
    for (let j = start; j < end; j++) sum += mono[j] * mono[j];
    energy[i] = Math.sqrt(sum / (end - start));
  }
  const onset = new Float32Array(numFrames);
  for (let i = 1; i < numFrames; i++) {
    const d = energy[i] - energy[i - 1];
    onset[i] = d > 0 ? d : 0;
  }
  const smoothed = new Float32Array(numFrames);
  const smoothWin = 5;
  for (let i = 0; i < numFrames; i++) {
    let s = 0, c = 0;
    for (let k = -smoothWin; k <= smoothWin; k++) {
      const idx = i + k;
      if (idx >= 0 && idx < numFrames) { s += onset[idx]; c++; }
    }
    smoothed[i] = onset[i] - s / c;
    if (smoothed[i] < 0) smoothed[i] = 0;
  }
  const minLag = Math.floor((60 / maxBPM) * frameRate);
  const maxLag = Math.ceil((60 / minBPM) * frameRate);
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag && lag < numFrames; lag++) {
    let score = 0;
    for (let i = 0; i + lag < numFrames; i++) score += smoothed[i] * smoothed[i + lag];
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  const bpm = (60 * frameRate) / bestLag;
  return Math.round(bpm * 10) / 10;
}

function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return w;
}

function wsolaFindPositions(mono, alpha, opts, onProgress) {
  opts = opts || {};
  const frameSize = opts.frameSize || 2048;
  const hopOut = opts.hopOut || 512;
  const tolerance = opts.tolerance || 256;
  const corrLen = opts.corrLen || 256;
  const searchStep = opts.searchStep || 2;

  const inputLen = mono.length;
  const hopIn = Math.max(1, Math.round(hopOut / alpha));
  const outputLength = Math.max(frameSize, Math.round(inputLen * alpha));

  const positions = [0];
  const outPositions = [0];

  let chosenPos = 0;
  let idealInPos = hopIn;
  let synthCount = 1;
  const overlapLen = Math.min(corrLen, frameSize - hopOut);
  let lastReport = 0;

  while (idealInPos + frameSize < inputLen) {
    const outPos = synthCount * hopOut;
    const refStart = chosenPos + hopOut;
    let bestOffset = 0;
    let bestScore = -Infinity;

    const lo = Math.max(-tolerance, -refStart, -idealInPos);
    const hi = Math.min(tolerance, inputLen - frameSize - idealInPos);

    for (let delta = lo; delta <= hi; delta += searchStep) {
      const candPos = idealInPos + delta;
      if (candPos < 0 || refStart < 0) continue;
      if (refStart + overlapLen > inputLen || candPos + overlapLen > inputLen) continue;
      let dot = 0, na = 0, nb = 0;
      for (let k = 0; k < overlapLen; k++) {
        const a = mono[refStart + k];
        const b = mono[candPos + k];
        dot += a * b; na += a * a; nb += b * b;
      }
      const score = dot / (Math.sqrt(na * nb) + 1e-9);
      if (score > bestScore) { bestScore = score; bestOffset = delta; }
    }

    chosenPos = idealInPos + bestOffset;
    if (chosenPos < 0) chosenPos = 0;
    if (chosenPos + frameSize > inputLen) chosenPos = inputLen - frameSize;

    positions.push(chosenPos);
    outPositions.push(outPos);

    synthCount++;
    idealInPos += hopIn;

    if (onProgress && idealInPos - lastReport > inputLen / 40) {
      lastReport = idealInPos;
      onProgress(Math.min(0.95, idealInPos / inputLen));
    }
  }

  return { positions: positions, outPositions: outPositions, frameSize: frameSize, outputLength: outputLength };
}

function wsolaApply(channelData, plan) {
  const positions = plan.positions, outPositions = plan.outPositions;
  const frameSize = plan.frameSize, outputLength = plan.outputLength;
  const output = new Float32Array(outputLength + frameSize);
  const winSum = new Float32Array(outputLength + frameSize);
  const window = hannWindow(frameSize);

  for (let f = 0; f < positions.length; f++) {
    const inStart = positions[f];
    const outStart = outPositions[f];
    for (let k = 0; k < frameSize; k++) {
      const srcIdx = inStart + k;
      if (srcIdx < 0 || srcIdx >= channelData.length) continue;
      const w = window[k];
      output[outStart + k] += channelData[srcIdx] * w;
      winSum[outStart + k] += w;
    }
  }
  for (let i = 0; i < output.length; i++) if (winSum[i] > 1e-6) output[i] /= winSum[i];
  return output.slice(0, outputLength);
}
`;

const WORKER_SOURCE = DSP_SOURCE + `
self.onmessage = function(e) {
  const msg = e.data;
  if (msg.type !== 'stretch') return;
  const channels = msg.channels;
  const mono = channels.length > 1
    ? channels[0].map((v, i) => (v + channels[1][i]) / 2)
    : channels[0];

  const plan = wsolaFindPositions(mono, msg.alpha, msg.opts, function(frac) {
    self.postMessage({ type: 'progress', id: msg.id, fraction: frac });
  });

  const outChannels = channels.map((ch) => wsolaApply(ch, plan));
  self.postMessage({ type: 'done', id: msg.id, channels: outChannels, length: outChannels[0].length },
    outChannels.map((c) => c.buffer));
};
`;

let worker = null;
function getWorker() {
  if (!worker) {
    const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
    worker = new Worker(URL.createObjectURL(blob));
  }
  return worker;
}

// estimateBPM is also needed on the main thread (for the initial detect-on-load
// step) — defined directly here rather than via eval(), since eval'd code inside
// 'use strict' does not leak declarations into the enclosing scope.
function estimateBPM(mono, sampleRate, minBPM, maxBPM) {
  minBPM = minBPM || 70; maxBPM = maxBPM || 185;
  const frameRate = 200;
  const hop = Math.round(sampleRate / frameRate);
  const numFrames = Math.floor(mono.length / hop);
  const energy = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    let sum = 0;
    const start = i * hop;
    const end = Math.min(start + hop, mono.length);
    for (let j = start; j < end; j++) sum += mono[j] * mono[j];
    energy[i] = Math.sqrt(sum / (end - start));
  }
  const onset = new Float32Array(numFrames);
  for (let i = 1; i < numFrames; i++) {
    const d = energy[i] - energy[i - 1];
    onset[i] = d > 0 ? d : 0;
  }
  const smoothed = new Float32Array(numFrames);
  const smoothWin = 5;
  for (let i = 0; i < numFrames; i++) {
    let s = 0, c = 0;
    for (let k = -smoothWin; k <= smoothWin; k++) {
      const idx = i + k;
      if (idx >= 0 && idx < numFrames) { s += onset[idx]; c++; }
    }
    smoothed[i] = onset[i] - s / c;
    if (smoothed[i] < 0) smoothed[i] = 0;
  }
  const minLag = Math.floor((60 / maxBPM) * frameRate);
  const maxLag = Math.ceil((60 / minBPM) * frameRate);
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag && lag < numFrames; lag++) {
    let score = 0;
    for (let i = 0; i + lag < numFrames; i++) score += smoothed[i] * smoothed[i + lag];
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  const bpm = (60 * frameRate) / bestLag;
  return Math.round(bpm * 10) / 10;
}

/* ---------------------------- App state ---------------------------- */
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function makeTrackState() {
  return {
    loaded: false,
    fileName: '',
    rawChannels: null,      // Float32Array[] decoded original (stereo-normalized)
    sampleRate: 44100,
    duration: 0,
    bpm: 120,
    trimStart: 0,
    trimEnd: 0,
    processedChannels: null, // after trim (+ stretch if active) — used for playback/render
    processedDuration: 0,
    peaks: null,             // downsampled peaks of rawChannels for drawing
    volume: 1.0,
    muted: false,
    solo: false,
  };
}

const state = {
  a: makeTrackState(),
  b: makeTrackState(),
  tempoMode: 'off',       // 'off' | 'b_to_a' | 'a_to_b'
  offsetB: 0,             // seconds, B's start time relative to A's start (0)
  snapToBeat: false,
  isPlaying: false,
  playStartedAt: 0,       // audioCtx.currentTime when play began
  playStartOffset: 0,     // transport position (sec) when play began
  sources: [],            // active AudioBufferSourceNodes + gains during playback
  rafHandle: null,
  recomputeTimer: null,
  jobCounter: 0,
};

/* ---------------------------- Utilities ---------------------------- */
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}
function fmtTimeMs(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec * 1000) % 1000);
  return m + ':' + String(s).padStart(2, '0') + '.' + String(ms).padStart(3, '0');
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function computePeaks(channelData, numBuckets) {
  const peaks = new Float32Array(numBuckets);
  const bucketSize = Math.max(1, Math.floor(channelData.length / numBuckets));
  for (let b = 0; b < numBuckets; b++) {
    let max = 0;
    const start = b * bucketSize;
    const end = Math.min(start + bucketSize, channelData.length);
    for (let i = start; i < end; i++) {
      const v = Math.abs(channelData[i]);
      if (v > max) max = v;
    }
    peaks[b] = max;
  }
  return peaks;
}

/* ---------------------------- File loading ---------------------------- */
async function decodeFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
  const numCh = audioBuffer.numberOfChannels;
  let left = audioBuffer.getChannelData(0);
  let right = numCh > 1 ? audioBuffer.getChannelData(1) : left;
  // copy out (decoded buffers can be reused/garbage by the browser)
  left = Float32Array.from(left);
  right = Float32Array.from(right);
  return { channels: [left, right], sampleRate: audioBuffer.sampleRate, duration: audioBuffer.duration };
}

async function loadTrack(key, file) {
  const track = state[key];
  const { channels, sampleRate, duration } = await decodeFile(file);
  track.loaded = true;
  track.fileName = file.name;
  track.rawChannels = channels;
  track.sampleRate = sampleRate;
  track.duration = duration;
  track.trimStart = 0;
  track.trimEnd = duration;
  track.peaks = computePeaks(channels[0], 400);

  const mono = channels[0];
  let bpm = 120;
  try { bpm = estimateBPM(mono, sampleRate); } catch (e) { /* keep default */ }
  track.bpm = bpm;

  els[key].filename.textContent = file.name;
  els[key].loadedPanel.classList.add('show');
  els[key].bpmInput.value = bpm;
  els[key].trimStartRange.max = duration;
  els[key].trimEndRange.max = duration;
  els[key].trimStartRange.value = 0;
  els[key].trimEndRange.value = duration;
  els[key].trimStartRange.step = Math.max(0.01, duration / 1000);
  els[key].trimEndRange.step = Math.max(0.01, duration / 1000);
  updateTrimLabels(key);
  drawMiniWave(key);

  await rebuildProcessed(key);
  updateExportEnabled();
  drawTimeline();
}

/* ---------------------------- Trim + stretch pipeline ---------------------------- */
function sliceChannels(channels, sampleRate, startSec, endSec) {
  const startIdx = Math.max(0, Math.floor(startSec * sampleRate));
  const endIdx = Math.min(channels[0].length, Math.ceil(endSec * sampleRate));
  return channels.map((ch) => ch.slice(startIdx, endIdx));
}

function runStretchJob(channels, alpha) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const id = ++state.jobCounter;
    const myId = id;

    function handler(e) {
      const msg = e.data;
      if (msg.id !== myId) return;
      if (msg.type === 'progress') {
        setStretchProgress(msg.fraction);
      } else if (msg.type === 'done') {
        w.removeEventListener('message', handler);
        resolve(msg.channels);
      }
    }
    w.addEventListener('message', handler);

    const transferable = channels.map((c) => c.slice().buffer);
    w.postMessage(
      { type: 'stretch', id: myId, channels: transferable.map((b) => new Float32Array(b)), alpha: alpha,
        opts: { frameSize: 2048, hopOut: 512, tolerance: 256, corrLen: 256, searchStep: 2 } },
      transferable
    );
  });
}

function setStretchProgress(frac) {
  els.stretchProgressWrap.classList.add('show');
  els.stretchProgressFill.style.width = Math.round(frac * 100) + '%';
  els.stretchProgressText.textContent = 'Stretching… ' + Math.round(frac * 100) + '%';
}
function hideStretchProgress() {
  els.stretchProgressWrap.classList.remove('show');
}

// Recomputes processedChannels for both tracks according to current trims + tempo mode.
async function rebuildProcessed(changedKey) {
  const a = state.a, b = state.b;

  // 1. Trim (cheap, always redone)
  const trimmedA = a.loaded ? sliceChannels(a.rawChannels, a.sampleRate, a.trimStart, a.trimEnd) : null;
  const trimmedB = b.loaded ? sliceChannels(b.rawChannels, b.sampleRate, b.trimStart, b.trimEnd) : null;

  let finalA = trimmedA;
  let finalB = trimmedB;

  // 2. Tempo stretch (only if both loaded and a mode selected)
  if (a.loaded && b.loaded && state.tempoMode !== 'off') {
    if (state.tempoMode === 'b_to_a') {
      const alpha = clamp(b.bpm / a.bpm, 0.5, 2.0);
      setStretchProgress(0);
      finalB = await runStretchJob(trimmedB, alpha);
      hideStretchProgress();
    } else if (state.tempoMode === 'a_to_b') {
      const alpha = clamp(a.bpm / b.bpm, 0.5, 2.0);
      setStretchProgress(0);
      finalA = await runStretchJob(trimmedA, alpha);
      hideStretchProgress();
    }
  }

  if (a.loaded) {
    a.processedChannels = finalA;
    a.processedDuration = finalA[0].length / a.sampleRate;
  }
  if (b.loaded) {
    b.processedChannels = finalB;
    b.processedDuration = finalB[0].length / b.sampleRate;
  }

  drawTimeline();
  updateTotalTimeReadout();
}

function scheduleRecompute() {
  clearTimeout(state.recomputeTimer);
  state.recomputeTimer = setTimeout(() => { rebuildProcessed(); }, 450);
}

/* ---------------------------- Drawing ---------------------------- */
function drawWaveBars(ctx, peaks, x0, y0, w, h, color, mirrored) {
  const n = peaks.length;
  const barW = w / n;
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const amp = peaks[i];
    const barH = Math.max(1, amp * h);
    const x = x0 + i * barW;
    const y = mirrored ? y0 - barH : y0;
    ctx.fillRect(x, y, Math.max(1, barW - 1), barH);
  }
}

function drawMiniWave(key) {
  const track = state[key];
  const canvas = els[key].waveCanvas;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!track.peaks) return;
  const color = key === 'a' ? '#6FA88C' : '#D1453B';
  const mid = h / 2;
  ctx.globalAlpha = 1;
  drawWaveBars(ctx, track.peaks, 0, mid, w, h / 2 - 2, color, false);
  drawWaveBars(ctx, track.peaks, 0, mid, w, h / 2 - 2, color, true);

  // shade the trimmed-out regions
  const totalDur = track.duration || 1;
  const trimStartX = (track.trimStart / totalDur) * w;
  const trimEndX = (track.trimEnd / totalDur) * w;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  if (trimStartX > 0) ctx.fillRect(0, 0, trimStartX, h);
  if (trimEndX < w) ctx.fillRect(trimEndX, 0, w - trimEndX, h);
}

let timelinePxPerSec = 60;

function drawTimeline() {
  const canvas = els.timelineCanvas;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w === 0) return;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const a = state.a, b = state.b;
  const durA = a.loaded ? a.processedDuration : 0;
  const durB = b.loaded ? b.processedDuration : 0;
  const totalDur = Math.max(durA, state.offsetB + durB, 1);

  timelinePxPerSec = w / totalDur;

  if (!a.loaded && !b.loaded) {
    ctx.fillStyle = '#5a564a';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Import both tracks to align them here', w / 2, h / 2);
    return;
  }

  // beat grid
  const gridBpm = state.tempoMode === 'b_to_a' ? a.bpm : (state.tempoMode === 'a_to_b' ? b.bpm : (a.loaded ? a.bpm : b.bpm));
  if (gridBpm > 0) {
    const beatSec = 60 / gridBpm;
    ctx.strokeStyle = 'rgba(242,238,227,0.06)';
    ctx.lineWidth = 1;
    for (let t = 0; t < totalDur; t += beatSec) {
      const x = t * timelinePxPerSec;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
  }

  const bandH = h / 2;

  // Track A band (top)
  if (a.loaded) {
    const peaksA = computePeaks(a.processedChannels[0], Math.max(20, Math.floor(durA * timelinePxPerSec / 2)));
    ctx.globalAlpha = 0.9;
    drawWaveBars(ctx, peaksA, 0, bandH / 2 + bandH * 0.5, durA * timelinePxPerSec, bandH * 0.42, '#6FA88C', false);
    drawWaveBars(ctx, peaksA, 0, bandH / 2 + bandH * 0.5, durA * timelinePxPerSec, bandH * 0.42, '#6FA88C', true);
  }

  // Track B band (bottom), offset
  if (b.loaded) {
    const xOff = state.offsetB * timelinePxPerSec;
    const peaksB = computePeaks(b.processedChannels[0], Math.max(20, Math.floor(durB * timelinePxPerSec / 2)));
    ctx.globalAlpha = 0.9;
    drawWaveBars(ctx, peaksB, xOff, bandH + bandH / 2 + bandH * 0.5, durB * timelinePxPerSec, bandH * 0.42, '#D1453B', false);
    drawWaveBars(ctx, peaksB, xOff, bandH + bandH / 2 + bandH * 0.5, durB * timelinePxPerSec, bandH * 0.42, '#D1453B', true);
  }

  // seam line
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(242,238,227,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, bandH); ctx.lineTo(w, bandH); ctx.stroke();

  // playhead
  if (state.isPlaying || state.playStartOffset > 0) {
    const playheadX = getTransportPosition() * timelinePxPerSec;
    ctx.strokeStyle = '#F2EEE3';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(playheadX, 0); ctx.lineTo(playheadX, h); ctx.stroke();
  }

  els.offsetReadout.textContent = fmtTimeMs(state.offsetB);
}

function updateTrimLabels(key) {
  const track = state[key];
  els[key].trimStartLabel.textContent = fmtTime(track.trimStart);
  els[key].trimEndLabel.textContent = fmtTime(track.trimEnd);
}

/* ---------------------------- Playback ---------------------------- */
function getActiveGain(track) {
  const anySolo = state.a.solo || state.b.solo;
  if (anySolo && !track.solo) return 0;
  if (track.muted) return 0;
  return track.volume;
}

function stopPlayback() {
  state.sources.forEach((s) => { try { s.source.stop(); } catch (e) {} });
  state.sources = [];
  state.isPlaying = false;
  if (state.rafHandle) cancelAnimationFrame(state.rafHandle);
  els.playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
}

function getTransportPosition() {
  if (!state.isPlaying) return state.playStartOffset;
  return state.playStartOffset + (audioCtx.currentTime - state.playStartedAt);
}

function getTotalDuration() {
  const durA = state.a.loaded ? state.a.processedDuration : 0;
  const durB = state.b.loaded ? state.b.processedDuration : 0;
  return Math.max(durA, state.offsetB + durB);
}

function makeBufferFromChannels(channels, sampleRate) {
  const buf = audioCtx.createBuffer(2, channels[0].length, sampleRate);
  buf.copyToChannel(channels[0], 0);
  buf.copyToChannel(channels[1], 1);
  return buf;
}

function startPlayback(fromSec) {
  stopPlayback();
  const total = getTotalDuration();
  if (total <= 0) return;
  fromSec = clamp(fromSec, 0, total);

  const t0 = audioCtx.currentTime + 0.05;
  state.playStartedAt = t0;
  state.playStartOffset = fromSec;

  [['a', 0], ['b', state.offsetB]].forEach(([key, trackOffset]) => {
    const track = state[key];
    if (!track.loaded) return;
    const gainVal = getActiveGain(track);
    const buf = makeBufferFromChannels(track.processedChannels, track.sampleRate);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const gain = audioCtx.createGain();
    gain.gain.value = gainVal;
    src.connect(gain).connect(audioCtx.destination);

    const trackLocalStart = fromSec - trackOffset;
    if (trackLocalStart >= track.processedDuration) return; // this track has already finished by `fromSec`
    if (trackLocalStart >= 0) {
      src.start(t0, trackLocalStart);
    } else {
      src.start(t0 - trackLocalStart);
    }
    state.sources.push({ source: src, gain: gain, key: key });
  });

  state.isPlaying = true;
  els.playIcon.innerHTML = '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>';
  tickPlayhead();
}

function tickPlayhead() {
  if (!state.isPlaying) return;
  const pos = getTransportPosition();
  const total = getTotalDuration();
  if (pos >= total) {
    stopPlayback();
    state.playStartOffset = 0;
    updateScrubUI(0, total);
    drawTimeline();
    return;
  }
  updateScrubUI(pos, total);
  drawTimeline();
  state.rafHandle = requestAnimationFrame(tickPlayhead);
}

function updateScrubUI(pos, total) {
  els.scrub.max = total || 1;
  els.scrub.value = pos;
  els.timeCurrent.textContent = fmtTime(pos);
  els.timeTotal.textContent = fmtTime(total);
}

function updateTotalTimeReadout() {
  const total = getTotalDuration();
  els.timeTotal.textContent = fmtTime(total);
  els.scrub.max = total || 1;
}

function updateMixGainsLive() {
  state.sources.forEach((s) => {
    s.gain.gain.value = getActiveGain(state[s.key]);
  });
}

/* ---------------------------- Export ---------------------------- */
async function renderMixdown() {
  const a = state.a, b = state.b;
  const total = getTotalDuration();
  const sampleRate = audioCtx.sampleRate;
  const length = Math.ceil(total * sampleRate) + 1;
  const offlineCtx = new OfflineAudioContext(2, length, sampleRate);

  [['a', 0], ['b', state.offsetB]].forEach(([key, trackOffset]) => {
    const track = state[key];
    if (!track.loaded) return;
    const gainVal = getActiveGain(track);
    if (gainVal <= 0) return;
    const buf = offlineCtx.createBuffer(2, track.processedChannels[0].length, track.sampleRate);
    buf.copyToChannel(track.processedChannels[0], 0);
    buf.copyToChannel(track.processedChannels[1], 1);
    const src = offlineCtx.createBufferSource();
    src.buffer = buf;
    const gain = offlineCtx.createGain();
    gain.gain.value = gainVal;
    src.connect(gain).connect(offlineCtx.destination);
    src.start(Math.max(0, trackOffset));
  });

  return offlineCtx.startRendering();
}

function floatTo16(channelData) {
  const out = new Int16Array(channelData.length);
  for (let i = 0; i < channelData.length; i++) {
    let s = clamp(channelData[i], -1, 1);
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out;
}

function encodeWAV(leftF, rightF, sampleRate) {
  const left = floatTo16(leftF), right = floatTo16(rightF);
  const len = left.length;
  const blockAlign = 4;
  const dataSize = len * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  function writeStr(off, s) { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 2, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); writeStr(36, 'data'); view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < len; i++) {
    view.setInt16(offset, left[i], true); offset += 2;
    view.setInt16(offset, right[i], true); offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

function setExportProgress(frac, label) {
  els.exportProgressWrap.classList.add('show');
  els.exportProgressFill.style.width = Math.round(frac * 100) + '%';
  els.exportProgressText.textContent = label || ('Rendering… ' + Math.round(frac * 100) + '%');
}
function hideExportProgress() { els.exportProgressWrap.classList.remove('show'); }

async function exportWAV() {
  els.exportWavBtn.disabled = true;
  setExportProgress(0.1, 'Rendering mix…');
  try {
    const rendered = await renderMixdown();
    setExportProgress(0.8, 'Encoding WAV…');
    const blob = encodeWAV(rendered.getChannelData(0), rendered.getChannelData(1), rendered.sampleRate);
    setExportProgress(1, 'Done');
    downloadBlob(blob, 'splice-mashup.wav');
  } finally {
    setTimeout(hideExportProgress, 600);
    els.exportWavBtn.disabled = false;
  }
}

async function exportMP3() {
  if (typeof lamejs === 'undefined') {
    alert('The MP3 encoder failed to load (no internet connection?). Try Export WAV instead, or reconnect and retry.');
    return;
  }
  els.exportMp3Btn.disabled = true;
  setExportProgress(0.05, 'Rendering mix…');
  try {
    const rendered = await renderMixdown();
    const left16 = floatTo16(rendered.getChannelData(0));
    const right16 = floatTo16(rendered.getChannelData(1));
    const kbps = parseInt(els.bitrateSelect.value, 10);
    const encoder = new lamejs.Mp3Encoder(2, rendered.sampleRate, kbps);
    const blockSize = 1152;
    const mp3Data = [];
    const total = left16.length;

    await new Promise((resolve) => {
      let i = 0;
      function step() {
        const chunkEnd = Math.min(i + blockSize * 200, total); // a few hundred frames per tick
        while (i < chunkEnd) {
          const end = Math.min(i + blockSize, total);
          const l = left16.subarray(i, end);
          const r = right16.subarray(i, end);
          const buf = encoder.encodeBuffer(l, r);
          if (buf.length > 0) mp3Data.push(buf);
          i = end;
        }
        setExportProgress(0.2 + 0.75 * (i / total), 'Encoding MP3…');
        if (i < total) setTimeout(step, 0);
        else resolve();
      }
      step();
    });

    const final = encoder.flush();
    if (final.length > 0) mp3Data.push(final);
    const blob = new Blob(mp3Data, { type: 'audio/mp3' });
    setExportProgress(1, 'Done');
    downloadBlob(blob, 'splice-mashup.mp3');
  } finally {
    setTimeout(hideExportProgress, 600);
    els.exportMp3Btn.disabled = false;
  }
}

function updateExportEnabled() {
  const ready = state.a.loaded && state.b.loaded;
  els.exportWavBtn.disabled = !ready;
  els.exportMp3Btn.disabled = !ready;
  els.playBtn.disabled = !ready;
}

/* ---------------------------- DOM wiring ---------------------------- */
const els = {
  a: {
    dropzone: document.getElementById('dropzone-a'),
    fileInput: document.getElementById('file-a'),
    loadedPanel: document.getElementById('loaded-a'),
    filename: document.getElementById('filename-a'),
    waveCanvas: document.getElementById('wave-a'),
    bpmInput: document.getElementById('bpm-a'),
    trimStartRange: document.getElementById('trim-a-start'),
    trimEndRange: document.getElementById('trim-a-end'),
    trimStartLabel: document.getElementById('trim-a-start-label'),
    trimEndLabel: document.getElementById('trim-a-end-label'),
    replaceBtn: document.getElementById('replace-a'),
  },
  b: {
    dropzone: document.getElementById('dropzone-b'),
    fileInput: document.getElementById('file-b'),
    loadedPanel: document.getElementById('loaded-b'),
    filename: document.getElementById('filename-b'),
    waveCanvas: document.getElementById('wave-b'),
    bpmInput: document.getElementById('bpm-b'),
    trimStartRange: document.getElementById('trim-b-start'),
    trimEndRange: document.getElementById('trim-b-end'),
    trimStartLabel: document.getElementById('trim-b-start-label'),
    trimEndLabel: document.getElementById('trim-b-end-label'),
    replaceBtn: document.getElementById('replace-b'),
  },
  timelineCanvas: document.getElementById('timeline-canvas'),
  offsetReadout: document.getElementById('offset-readout'),
  snapToggle: document.getElementById('snap-toggle'),
  stretchProgressWrap: document.getElementById('stretch-progress'),
  stretchProgressFill: document.getElementById('stretch-progress-fill'),
  stretchProgressText: document.getElementById('stretch-progress-text'),
  exportProgressWrap: document.getElementById('export-progress'),
  exportProgressFill: document.getElementById('export-progress-fill'),
  exportProgressText: document.getElementById('export-progress-text'),
  volA: document.getElementById('vol-a'),
  volB: document.getElementById('vol-b'),
  volAReadout: document.getElementById('vol-a-readout'),
  volBReadout: document.getElementById('vol-b-readout'),
  muteA: document.getElementById('mute-a'),
  muteB: document.getElementById('mute-b'),
  soloA: document.getElementById('solo-a'),
  soloB: document.getElementById('solo-b'),
  playBtn: document.getElementById('play-btn'),
  playIcon: document.getElementById('play-icon'),
  stopBtn: document.getElementById('stop-btn'),
  scrub: document.getElementById('scrub'),
  timeCurrent: document.getElementById('time-current'),
  timeTotal: document.getElementById('time-total'),
  exportWavBtn: document.getElementById('export-wav'),
  exportMp3Btn: document.getElementById('export-mp3'),
  bitrateSelect: document.getElementById('bitrate'),
  installBtn: document.getElementById('install-btn'),
};

['a', 'b'].forEach((key) => {
  const e = els[key];

  e.dropzone.addEventListener('click', () => e.fileInput.click());
  e.fileInput.addEventListener('change', () => {
    if (e.fileInput.files[0]) loadTrack(key, e.fileInput.files[0]);
  });
  e.replaceBtn.addEventListener('click', (ev) => { ev.stopPropagation(); e.fileInput.click(); });

  ['dragover', 'dragenter'].forEach((evt) =>
    e.dropzone.addEventListener(evt, (ev) => { ev.preventDefault(); e.dropzone.classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    e.dropzone.addEventListener(evt, (ev) => { ev.preventDefault(); e.dropzone.classList.remove('dragover'); })
  );
  e.dropzone.addEventListener('drop', (ev) => {
    const file = ev.dataTransfer.files[0];
    if (file) loadTrack(key, file);
  });

  e.bpmInput.addEventListener('change', () => {
    const v = parseFloat(e.bpmInput.value);
    if (isFinite(v) && v > 0) { state[key].bpm = v; scheduleRecompute(); drawTimeline(); }
  });

  e.trimStartRange.addEventListener('input', () => {
    let v = parseFloat(e.trimStartRange.value);
    if (v >= state[key].trimEnd) v = Math.max(0, state[key].trimEnd - 0.1);
    state[key].trimStart = v;
    updateTrimLabels(key); drawMiniWave(key); scheduleRecompute();
  });
  e.trimEndRange.addEventListener('input', () => {
    let v = parseFloat(e.trimEndRange.value);
    if (v <= state[key].trimStart) v = Math.min(state[key].duration, state[key].trimStart + 0.1);
    state[key].trimEnd = v;
    updateTrimLabels(key); drawMiniWave(key); scheduleRecompute();
  });
});

document.querySelectorAll('.tempo-mode button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tempo-mode button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.tempoMode = btn.dataset.mode;
    rebuildProcessed();
  });
});

function volLabel(key) {
  const slider = key === 'a' ? els.volA : els.volB;
  const readout = key === 'a' ? els.volAReadout : els.volBReadout;
  readout.textContent = slider.value + '%';
}
els.volA.addEventListener('input', () => { state.a.volume = els.volA.value / 100; volLabel('a'); updateMixGainsLive(); });
els.volB.addEventListener('input', () => { state.b.volume = els.volB.value / 100; volLabel('b'); updateMixGainsLive(); });

els.muteA.addEventListener('click', () => { state.a.muted = !state.a.muted; els.muteA.classList.toggle('on', state.a.muted); updateMixGainsLive(); });
els.muteB.addEventListener('click', () => { state.b.muted = !state.b.muted; els.muteB.classList.toggle('on', state.b.muted); updateMixGainsLive(); });
els.soloA.addEventListener('click', () => { state.a.solo = !state.a.solo; els.soloA.classList.toggle('on', state.a.solo); updateMixGainsLive(); });
els.soloB.addEventListener('click', () => { state.b.solo = !state.b.solo; els.soloB.classList.toggle('on', state.b.solo); updateMixGainsLive(); });

els.playBtn.addEventListener('click', () => {
  if (state.isPlaying) { stopPlayback(); state.playStartOffset = getTransportPosition(); }
  else startPlayback(state.playStartOffset);
});
els.stopBtn.addEventListener('click', () => {
  stopPlayback();
  state.playStartOffset = 0;
  updateScrubUI(0, getTotalDuration());
  drawTimeline();
});
els.scrub.addEventListener('input', () => {
  const wasPlaying = state.isPlaying;
  stopPlayback();
  state.playStartOffset = parseFloat(els.scrub.value);
  updateScrubUI(state.playStartOffset, getTotalDuration());
  drawTimeline();
  if (wasPlaying) startPlayback(state.playStartOffset);
});

els.snapToggle.addEventListener('change', () => { state.snapToBeat = els.snapToggle.checked; });

document.querySelectorAll('.nudge-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const ms = parseInt(btn.dataset.nudge, 10);
    state.offsetB = clamp(state.offsetB + ms / 1000, 0, 600);
    drawTimeline();
  });
});

/* Timeline drag-to-align */
(function setupTimelineDrag() {
  const canvas = els.timelineCanvas;
  let dragging = false;
  let dragStartX = 0;
  let dragStartOffset = 0;

  function pointerDown(ev) {
    dragging = true;
    dragStartX = ev.clientX;
    dragStartOffset = state.offsetB;
    canvas.setPointerCapture(ev.pointerId);
  }
  function pointerMove(ev) {
    if (!dragging) return;
    const dx = ev.clientX - dragStartX;
    let newOffset = dragStartOffset + dx / timelinePxPerSec;
    if (state.snapToBeat) {
      const bpm = state.tempoMode === 'b_to_a' ? state.a.bpm : (state.tempoMode === 'a_to_b' ? state.b.bpm : state.a.bpm);
      const beatSec = 60 / (bpm || 120);
      newOffset = Math.round(newOffset / beatSec) * beatSec;
    }
    state.offsetB = clamp(newOffset, 0, 600);
    drawTimeline();
  }
  function pointerUp(ev) {
    dragging = false;
    try { canvas.releasePointerCapture(ev.pointerId); } catch (e) {}
  }
  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('pointercancel', pointerUp);
})();

els.exportWavBtn.addEventListener('click', exportWAV);
els.exportMp3Btn.addEventListener('click', exportMP3);

window.addEventListener('resize', () => {
  if (state.a.loaded) drawMiniWave('a');
  if (state.b.loaded) drawMiniWave('b');
  drawTimeline();
});

/* ---------------------------- PWA install + service worker ---------------------------- */
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  els.installBtn.style.display = 'inline-block';
});
els.installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  els.installBtn.style.display = 'none';
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

/* ---------------------------- Init ---------------------------- */
updateExportEnabled();
drawTimeline();
updateScrubUI(0, 0);

})();
