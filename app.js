const GRID_COLUMNS = 10;
const GRID_ROWS = 20;
const LED_COUNT = GRID_COLUMNS * GRID_ROWS;
const STEP_COUNT = 16;
const LOOP_MAX_EVENTS = 96;

const grid = document.querySelector("#ledGrid");
const canvas = document.querySelector("#gestureCanvas");
const ctx = canvas.getContext("2d");
const powerButton = document.querySelector("#powerButton");
const clearButton = document.querySelector("#clearButton");
const holdButton = document.querySelector("#holdButton");
const energySlider = document.querySelector("#energySlider");
const lfoSlider = document.querySelector("#lfoSlider");
const resonanceSlider = document.querySelector("#resonanceSlider");
const tempoText = document.querySelector("#tempoText");
const moodText = document.querySelector("#moodText");

const pads = Array.from({ length: LED_COUNT }, (_, index) => ({
  index,
  x: index % GRID_COLUMNS,
  y: Math.floor(index / GRID_COLUMNS),
  heat: 0,
  memory: 0,
  aura: 0,
  auraColor: "#8cffc7",
  lastHit: 0,
}));

const colors = ["#8cffc7", "#63d7ff", "#ffcc6d", "#ff6d9d"];
const pointerState = new Map();
let holdLights = true;
let running = false;
let audio = null;
let currentStep = -1;
let lastFrame = performance.now();
let gestureTrace = [];
let gestureVelocity = 0;
let multiTouchIntensity = 0;
let multiTouchSpread = 0;
let recentChordAt = 0;
let loopEvents = [];
let loopPulse = 0;
let mood = {
  x: 0.48,
  y: 0.54,
  pressure: 0,
  energy: 0.62,
  lfo: 0.34,
  resonance: 0.46,
};

function createPads() {
  const fragment = document.createDocumentFragment();
  pads.forEach((pad) => {
    const button = document.createElement("button");
    button.className = "led";
    button.type = "button";
    button.dataset.index = pad.index;
    button.ariaLabel = `LED ${pad.index + 1}`;
    button.style.setProperty("--led-color", padColor(pad));
    fragment.append(button);
  });
  grid.append(fragment);
}

function padColor(pad) {
  if (pad.y <= 4) return colors[1];
  if (pad.y <= 10) return colors[0];
  if (pad.y <= 15) return colors[2];
  return colors[3];
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * scale));
  canvas.height = Math.max(1, Math.floor(rect.height * scale));
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
}

function padFromPoint(clientX, clientY) {
  const cell = cellFromPoint(clientX, clientY);
  if (!cell) return null;
  return pads[cell.row * GRID_COLUMNS + cell.column];
}

function cellFromPoint(clientX, clientY) {
  const rect = grid.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
  const column = Math.floor(clamp((clientX - rect.left) / rect.width, 0, 0.999) * GRID_COLUMNS);
  const row = Math.floor(clamp((clientY - rect.top) / rect.height, 0, 0.999) * GRID_ROWS);
  return { column, row };
}

function padsBetween(fromX, fromY, toX, toY) {
  const rect = grid.getBoundingClientRect();
  const cellSize = Math.max(12, Math.min(rect.width / GRID_COLUMNS, rect.height / GRID_ROWS));
  const distance = Math.hypot(toX - fromX, toY - fromY);
  const steps = Math.max(1, Math.ceil(distance / (cellSize * 0.48)));
  const seen = new Set();
  const result = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const pad = padFromPoint(fromX + (toX - fromX) * t, fromY + (toY - fromY) * t);
    if (pad && !seen.has(pad.index)) {
      seen.add(pad.index);
      result.push(pad);
    }
  }
  return result;
}

function strikePad(pad, event, force = 1, options = {}) {
  const settings = {
    audible: true,
    record: true,
    ghost: false,
    ...options,
  };
  const now = performance.now();
  if (!settings.ghost && now - pad.lastHit < 42 && force < 1.15) return;
  if (!settings.ghost) pad.lastHit = now;
  pad.heat = Math.min(1, pad.heat + 0.86 * force);
  pad.memory = holdLights ? Math.min(1, pad.memory + 0.18 * force) : Math.min(0.72, pad.memory + 0.09 * force);
  bloomAroundPad(pad, force, settings.ghost);

  const rect = grid.getBoundingClientRect();
  mood.x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  mood.y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
  mood.pressure = clamp(force + multiTouchIntensity * 0.28, 0, 1.8);

  gestureTrace.push({
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
    life: 1,
    color: padColor(pad),
    width: 1 + multiTouchIntensity * 0.65,
  });
  if (gestureTrace.length > 64) gestureTrace.shift();

  if (settings.record && running) {
    rememberLoopEvent(pad, event, force);
  }

  if (settings.audible && running && audio) {
    audio.touch(pad, mood);
  }
}

function bloomAroundPad(source, force, ghost = false) {
  const radius = ghost ? 1.35 : 2.45 + multiTouchIntensity * 0.75;
  const color = padColor(source);
  const strength = clamp(force, 0.16, 1.6) * (ghost ? 0.34 : 0.62);

  for (let y = Math.max(0, Math.floor(source.y - radius)); y <= Math.min(GRID_ROWS - 1, Math.ceil(source.y + radius)); y += 1) {
    for (let x = Math.max(0, Math.floor(source.x - radius)); x <= Math.min(GRID_COLUMNS - 1, Math.ceil(source.x + radius)); x += 1) {
      const pad = padAt(x, y);
      if (!pad || pad.index === source.index) continue;
      const distance = Math.hypot(source.x - x, source.y - y);
      if (distance > radius) continue;
      const falloff = Math.pow(1 - distance / (radius + 0.001), 1.7);
      pad.aura = Math.min(1, pad.aura + strength * falloff);
      pad.auraColor = color;
    }
  }
}

function rememberLoopEvent(pad, event, force) {
  const rect = grid.getBoundingClientRect();
  const step = currentStep >= 0 ? currentStep : 0;
  const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
  const recent = loopEvents.find((item) => item.padIndex === pad.index && item.step === step);

  if (recent) {
    recent.life = Math.min(1, recent.life + 0.22);
    recent.force = Math.max(recent.force, clamp(force, 0.18, 1.8));
    recent.x = x;
    recent.y = y;
    recent.color = padColor(pad);
    recent.age = 0;
    return;
  }

  loopEvents.push({
    padIndex: pad.index,
    step,
    force: clamp(force, 0.18, 1.8),
    x,
    y,
    color: padColor(pad),
    life: 1,
    age: 0,
  });

  if (loopEvents.length > LOOP_MAX_EVENTS) {
    loopEvents.sort((a, b) => (a.life - b.life) || (b.age - a.age));
    loopEvents = loopEvents.slice(loopEvents.length - LOOP_MAX_EVENTS);
  }
}

function onPointerDown(event) {
  const pad = padFromPoint(event.clientX, event.clientY);
  if (!pad) return;
  event.preventDefault();
  grid.setPointerCapture(event.pointerId);
  pointerState.set(event.pointerId, {
    x: event.clientX,
    y: event.clientY,
    startX: event.clientX,
    startY: event.clientY,
    time: performance.now(),
    pressure: event.pressure || 1,
    lastPad: pad.index,
  });
  updateMultiTouchMood();
  strikePad(pad, event, (event.pressure || 1) + multiTouchIntensity * 0.24);
  triggerChordAccent(event);
}

function onPointerMove(event) {
  if (!pointerState.has(event.pointerId)) return;
  event.preventDefault();
  const events = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];
  events.forEach((moveEvent) => processPointerMove(event.pointerId, moveEvent));
}

function processPointerMove(pointerId, event) {
  const state = pointerState.get(pointerId);
  if (!state) return;
  const now = performance.now();
  const distance = Math.hypot(event.clientX - state.x, event.clientY - state.y);
  const elapsed = Math.max(16, now - state.time);
  gestureVelocity = Math.max(gestureVelocity, clamp(distance / elapsed / 1.8, 0, 1));
  const force = 0.62 + gestureVelocity * 0.6 + multiTouchIntensity * 0.26;
  const strokePads = padsBetween(state.x, state.y, event.clientX, event.clientY);

  state.x = event.clientX;
  state.y = event.clientY;
  state.time = now;
  state.pressure = event.pressure || state.pressure || 1;
  updateMultiTouchMood();

  strokePads.forEach((pad) => {
    if (pad.index !== state.lastPad || gestureVelocity > 0.32) {
      state.lastPad = pad.index;
      strikePad(pad, event, force);
    }
  });
}

function onPointerUp(event) {
  pointerState.delete(event.pointerId);
  if (grid.hasPointerCapture(event.pointerId)) grid.releasePointerCapture(event.pointerId);
  updateMultiTouchMood();
}

function updateMultiTouchMood() {
  const touches = Array.from(pointerState.values());
  if (!touches.length) {
    multiTouchIntensity *= 0.78;
    multiTouchSpread *= 0.8;
    return;
  }

  const rect = grid.getBoundingClientRect();
  const center = touches.reduce((point, touch) => ({
    x: point.x + touch.x,
    y: point.y + touch.y,
  }), { x: 0, y: 0 });
  center.x /= touches.length;
  center.y /= touches.length;

  let spread = 0;
  touches.forEach((touch) => {
    spread += Math.hypot(touch.x - center.x, touch.y - center.y);
  });
  const diagonal = Math.hypot(rect.width, rect.height);
  multiTouchIntensity = clamp((touches.length - 1) / 3, 0, 1);
  multiTouchSpread = clamp((spread / touches.length) / (diagonal * 0.38), 0, 1);
  mood.x = clamp((center.x - rect.left) / rect.width, 0, 1);
  mood.y = clamp((center.y - rect.top) / rect.height, 0, 1);
  mood.pressure = clamp(touches.reduce((sum, touch) => sum + touch.pressure, 0) / touches.length, 0, 1.8);
  document.documentElement.style.setProperty("--touches", String(touches.length));
  document.documentElement.style.setProperty("--touch-glow", `${touches.length * 8}px`);
}

function triggerChordAccent(event) {
  const now = performance.now();
  if (pointerState.size < 2 || now - recentChordAt < 180) return;
  recentChordAt = now;
  const touches = Array.from(pointerState.values());
  const centerX = touches.reduce((sum, touch) => sum + touch.x, 0) / touches.length;
  const centerY = touches.reduce((sum, touch) => sum + touch.y, 0) / touches.length;
  const centerPad = padFromPoint(centerX, centerY);
  if (!centerPad) return;

  const chordEvent = { clientX: centerX, clientY: centerY };
  const neighbors = [
    centerPad,
    padAt(centerPad.x - 1, centerPad.y),
    padAt(centerPad.x + 1, centerPad.y),
    padAt(centerPad.x, centerPad.y - 1),
    padAt(centerPad.x, centerPad.y + 1),
  ].filter(Boolean);
  neighbors.forEach((pad, index) => strikePad(pad, chordEvent, 0.74 + multiTouchIntensity * 0.42, { record: index === 0 }));
  if (running && audio) audio.chord(centerPad, pointerState.size, mood);
}

function padAt(x, y) {
  if (x < 0 || x >= GRID_COLUMNS || y < 0 || y >= GRID_ROWS) return null;
  return pads[y * GRID_COLUMNS + x];
}

function replayLoopStep(step, time, engine) {
  if (!loopEvents.length) return;

  let played = 0;
  loopEvents.forEach((item) => {
    if (item.step !== step || item.life < 0.08) return;
    item.age += 1;
    item.life *= 0.955;

    if (!randomChance(0.5 + item.life * 0.48)) return;
    const pad = pads[item.padIndex];
    if (!pad) return;

    const rect = grid.getBoundingClientRect();
    const ghostEvent = {
      clientX: rect.left + item.x * rect.width,
      clientY: rect.top + item.y * rect.height,
    };
    const force = item.force * (0.26 + item.life * 0.55);
    const drift = (Math.random() - 0.5) * 0.018 + multiTouchSpread * 0.008;
    strikePad(pad, ghostEvent, force, { audible: false, record: false, ghost: true });
    engine.touchAt(pad, { ...mood, pressure: force }, time + played * 0.012 + drift, clamp(0.2 + item.life * 0.5, 0.18, 0.74));
    loopPulse = Math.max(loopPulse, item.life);
    played += 1;
  });

  loopEvents = loopEvents.filter((item) => item.life >= 0.08);
}

class LedAudio {
  constructor() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    this.context = new AudioContext();
    this.master = this.context.createGain();
    this.master.gain.value = 0.72;
    this.globalFilter = this.context.createBiquadFilter();
    this.globalFilter.type = "lowpass";
    this.globalFilter.frequency.value = 1650;
    this.globalFilter.Q.value = 4.5;
    this.lfoOsc = this.context.createOscillator();
    this.lfoDepth = this.context.createGain();
    this.lfoOsc.type = "sine";
    this.lfoOsc.frequency.value = 0.18;
    this.lfoDepth.gain.value = 420;
    this.compressor = this.context.createDynamicsCompressor();
    this.compressor.threshold.value = -19;
    this.compressor.knee.value = 24;
    this.compressor.ratio.value = 5;
    this.compressor.attack.value = 0.006;
    this.compressor.release.value = 0.18;
    this.delay = this.context.createDelay(0.7);
    this.delay.delayTime.value = 0.22;
    this.feedback = this.context.createGain();
    this.feedback.gain.value = 0.22;
    this.wet = this.context.createGain();
    this.wet.gain.value = 0.14;
    this.noise = this.makeNoiseBuffer();

    this.master.connect(this.globalFilter);
    this.globalFilter.connect(this.compressor);
    this.compressor.connect(this.context.destination);
    this.master.connect(this.delay);
    this.delay.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.delay.connect(this.wet);
    this.wet.connect(this.globalFilter);
    this.lfoOsc.connect(this.lfoDepth);
    this.lfoDepth.connect(this.globalFilter.detune);
    this.lfoOsc.start();

    this.nextStepAt = this.context.currentTime + 0.08;
    this.timer = window.setInterval(() => this.scheduler(), 26);
    this.updateFx(this.context.currentTime);
  }

  async start() {
    await this.context.resume();
  }

  stop() {
    window.clearInterval(this.timer);
    this.lfoOsc.stop();
    this.context.close();
  }

  makeNoiseBuffer() {
    const length = this.context.sampleRate;
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  scheduler() {
    const lookAhead = 0.12;
    while (this.nextStepAt < this.context.currentTime + lookAhead) {
      const step = (currentStep + 1 + STEP_COUNT) % STEP_COUNT;
      scheduleVisualStep(step);
      this.step(step, this.nextStepAt);
      this.nextStepAt += 60 / getTempo() / 4;
    }
  }

  step(step, time) {
    const energy = mood.energy;
    const active = pads.reduce((sum, pad) => sum + pad.memory + pad.heat * 0.35, 0) / LED_COUNT;
    const chaos = clamp(gestureVelocity * 0.55 + active * 0.92 + energy * 0.2 + multiTouchIntensity * 0.18 + multiTouchSpread * 0.12, 0, 1);
    const columnEnergy = columnAmount(step % GRID_COLUMNS);
    const altColumn = columnAmount((step + 5) % GRID_COLUMNS);

    this.updateFx(time);
    this.delay.delayTime.setTargetAtTime(0.12 + mood.x * 0.24, time, 0.02);
    this.feedback.gain.setTargetAtTime(0.08 + chaos * 0.28, time, 0.05);
    this.wet.gain.setTargetAtTime(0.07 + mood.x * 0.14, time, 0.05);

    if (step % 8 === 0 || (step === 6 && randomChance(columnEnergy * 0.5))) {
      this.kick(time, 0.88 + energy * 0.24);
    }
    if ((step === 4 || step === 12) || randomChance(altColumn * chaos * 0.24)) {
      this.snare(time, 0.58 + chaos * 0.28);
    }
    if (step % 2 === 0 || randomChance(0.18 + chaos * 0.38)) {
      this.hat(time, 0.18 + energy * 0.22 + columnEnergy * 0.24);
    }
    if ((step % 4 === 2 && randomChance(0.65 + active)) || randomChance(columnEnergy * 0.42)) {
      this.synth(time, step, 0.24 + columnEnergy * 0.48);
    }
    if ((step === 0 || step === 10 || randomChance(chaos * 0.1)) && energy > 0.42) {
      this.bass(time, step, 0.34 + energy * 0.42);
    }
    if (randomChance(chaos * 0.1)) {
      const repeat = 1 + Math.floor(chaos * 3);
      for (let i = 0; i < repeat; i += 1) {
        this.hat(time + i * 0.035, 0.12 + chaos * 0.16);
      }
    }
    replayLoopStep(step, time, this);
  }

  touch(pad, tone) {
    this.touchAt(pad, tone, this.context.currentTime + 0.004, 1);
  }

  touchAt(pad, tone, time, level = 1) {
    const gain = 0.12 + pad.heat * 0.3;
    this.updateFx(time);
    if (pad.y >= 16) this.kick(time, (0.45 + gain) * level);
    else if (pad.y >= 12) this.bass(time, pad.x + pad.y, (0.25 + gain) * level);
    else if (pad.y >= 5) this.synth(time, pad.x + pad.y, (0.22 + gain) * level);
    else if (pad.x % 2) this.hat(time, (0.16 + gain) * level);
    else this.snare(time, (0.18 + tone.pressure * 0.32) * level);
  }

  updateFx(time) {
    const lfo = mood.lfo;
    const resonance = mood.resonance;
    const cutoff = 520 + mood.x * 2800 + mood.energy * 860 - mood.y * 280;
  const lfoRate = 0.04 + lfo * lfo * 7.4 + gestureVelocity * 2.2;
    const lfoDepth = 10 + lfo * (240 + resonance * 980 + multiTouchIntensity * 760);
    this.globalFilter.frequency.setTargetAtTime(clamp(cutoff + multiTouchSpread * 960, 160, 6200), time, 0.035);
    this.globalFilter.Q.setTargetAtTime(0.8 + resonance * 17 + multiTouchIntensity * 4.5, time, 0.04);
    this.lfoOsc.frequency.setTargetAtTime(lfoRate, time, 0.06);
    this.lfoDepth.gain.setTargetAtTime(lfoDepth, time, 0.05);
  }

  chord(pad, count, tone) {
    const time = this.context.currentTime + 0.012;
    const amount = clamp(0.24 + count * 0.12 + multiTouchSpread * 0.24, 0.28, 0.86);
    this.synth(time, pad.x + pad.y + count, amount);
    if (count >= 3) this.snare(time + 0.018, 0.32 + tone.pressure * 0.18);
    if (pad.y >= 12 || count >= 4) this.bass(time + 0.032, pad.x + count, amount * 0.78);
  }

  kick(time, amount) {
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(118, time);
    osc.frequency.exponentialRampToValueAtTime(42, time + 0.14);
    gain.gain.setValueAtTime(0.001, time);
    gain.gain.exponentialRampToValueAtTime(0.82 * amount, time + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.32);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(time);
    osc.stop(time + 0.34);
  }

  snare(time, amount) {
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    const snap = this.context.createOscillator();
    const snapGain = this.context.createGain();
    source.buffer = this.noise;
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(1700 + mood.x * 900, time);
    filter.Q.value = 0.76;
    gain.gain.setValueAtTime(0.001, time);
    gain.gain.exponentialRampToValueAtTime(0.44 * amount, time + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.16);
    snap.type = "triangle";
    snap.frequency.setValueAtTime(190, time);
    snapGain.gain.setValueAtTime(0.15 * amount, time);
    snapGain.gain.exponentialRampToValueAtTime(0.001, time + 0.08);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    snap.connect(snapGain);
    snapGain.connect(this.master);
    source.start(time);
    source.stop(time + 0.18);
    snap.start(time);
    snap.stop(time + 0.1);
  }

  hat(time, amount) {
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    source.buffer = this.noise;
    filter.type = "highpass";
    filter.frequency.setValueAtTime(5600 + mood.y * 3600, time);
    gain.gain.setValueAtTime(0.001, time);
    gain.gain.exponentialRampToValueAtTime(0.36 * amount, time + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.055 + mood.x * 0.08);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start(time);
    source.stop(time + 0.16);
  }

  bass(time, seed, amount) {
    const osc = this.context.createOscillator();
    const sub = this.context.createOscillator();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    const note = [36, 36, 43, 39, 34, 46, 41, 39][seed % 8];
    const freq = midiToFrequency(note);
    osc.type = "sawtooth";
    sub.type = "square";
    osc.frequency.setValueAtTime(freq, time);
    sub.frequency.setValueAtTime(freq / 2, time);
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(120 + mood.x * 850, time);
    filter.frequency.exponentialRampToValueAtTime(64 + mood.y * 220, time + 0.24);
    filter.Q.value = 8 + mood.energy * 7;
    gain.gain.setValueAtTime(0.001, time);
    gain.gain.exponentialRampToValueAtTime(0.42 * amount, time + 0.014);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.28);
    osc.connect(filter);
    sub.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    osc.start(time);
    sub.start(time);
    osc.stop(time + 0.3);
    sub.stop(time + 0.3);
  }

  synth(time, seed, amount) {
    const oscA = this.context.createOscillator();
    const oscB = this.context.createOscillator();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    const scale = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22];
    const octave = mood.y < 0.42 ? 60 : 48;
    const freq = midiToFrequency(octave + scale[seed % scale.length]);
    oscA.type = "sawtooth";
    oscB.type = "triangle";
    oscA.frequency.setValueAtTime(freq, time);
    oscB.frequency.setValueAtTime(freq * (1.005 + mood.x * 0.01), time);
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(420 + mood.x * 2600, time);
    filter.Q.value = 2 + mood.energy * 6;
    gain.gain.setValueAtTime(0.001, time);
    gain.gain.exponentialRampToValueAtTime(0.24 * amount, time + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.22 + mood.y * 0.42);
    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    oscA.start(time);
    oscB.start(time);
    oscA.stop(time + 0.72);
    oscB.stop(time + 0.72);
  }
}

function scheduleVisualStep(step) {
  currentStep = step;
}

function columnAmount(column) {
  let sum = 0;
  for (let row = 0; row < GRID_ROWS; row += 1) {
    const pad = pads[row * GRID_COLUMNS + column];
    sum += pad.memory + pad.heat * 0.6;
  }
  return clamp(sum / GRID_ROWS, 0, 1);
}

function updateVisuals(now) {
  const dt = Math.min(40, now - lastFrame) / 16.67;
  lastFrame = now;
  const ledElements = grid.children;
  let total = 0;
  loopPulse *= Math.pow(0.86, dt);
  document.documentElement.style.setProperty("--loop", loopPulse.toFixed(2));
  document.documentElement.style.setProperty("--loop-glow", `${Math.round(loopPulse * 42)}px`);
  if (!pointerState.size) {
    multiTouchIntensity *= Math.pow(0.86, dt);
    multiTouchSpread *= Math.pow(0.9, dt);
    document.documentElement.style.setProperty("--touches", "0");
    document.documentElement.style.setProperty("--touch-glow", "0px");
  }

  pads.forEach((pad, index) => {
    const decay = holdLights ? 0.972 : 0.93;
    pad.heat *= Math.pow(0.82, dt);
    pad.memory *= Math.pow(decay, dt);
    pad.aura *= Math.pow(0.9, dt);
    total += pad.memory + pad.heat + pad.aura * 0.34;

    const glow = clamp(pad.memory * 0.8 + pad.heat, 0, 1);
    const led = ledElements[index];
    led.style.setProperty("--glow", glow.toFixed(3));
    led.style.setProperty("--aura", pad.aura.toFixed(3));
    led.style.setProperty("--aura-color", pad.auraColor);
    led.classList.toggle("is-on", glow > 0.045);
    led.classList.toggle("has-aura", pad.aura > 0.035);
    led.classList.toggle("is-step", running && pad.x === currentStep % GRID_COLUMNS);
  });

  drawGesture();
  updateReadout(total / LED_COUNT);
  requestAnimationFrame(updateVisuals);
}

function drawGesture() {
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  gestureTrace.forEach((point, index) => {
    const next = gestureTrace[index + 1];
    if (!next) return;
    ctx.strokeStyle = hexToRgba(point.color, point.life * 0.44);
    ctx.lineWidth = 2 + point.life * 8 * point.width;
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();
  });
  gestureTrace = gestureTrace
    .map((point) => ({ ...point, life: point.life * 0.91 }))
    .filter((point) => point.life > 0.035);
  gestureVelocity *= 0.965;
}

function updateReadout(active) {
  mood.energy = Number(energySlider.value) / 100;
  mood.lfo = Number(lfoSlider.value) / 100;
  mood.resonance = Number(resonanceSlider.value) / 100;
  document.documentElement.style.setProperty("--lfo", mood.lfo.toFixed(2));
  document.documentElement.style.setProperty("--res", mood.resonance.toFixed(2));
  tempoText.textContent = Math.round(getTempo());
  const loopLevel = clamp(loopEvents.reduce((sum, item) => sum + item.life, 0) / 18, 0, 1);
  const level = clamp(active * 2.4 + gestureVelocity * 0.45 + mood.energy * 0.24 + mood.resonance * 0.12 + mood.lfo * 0.08 + multiTouchIntensity * 0.18 + loopLevel * 0.12, 0, 1);
  moodText.textContent = loopLevel > 0.45 && level > 0.34 ? "LOOP" : level > 0.72 ? "WILD" : level > 0.45 ? "DUB" : level > 0.24 ? "WARM" : "SOFT";
}

function getTempo() {
  return 92 + mood.energy * 72 + gestureVelocity * 18 + multiTouchIntensity * 8;
}

function midiToFrequency(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

function randomChance(chance) {
  return Math.random() < clamp(chance, 0, 1);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

async function togglePower() {
  if (!running) {
    if (!audio) audio = new LedAudio();
    await audio.start();
    running = true;
    powerButton.setAttribute("aria-pressed", "true");
    powerButton.querySelector(".power-text").textContent = "LIVE";
    seedFirstPulse();
  } else {
    running = false;
    powerButton.setAttribute("aria-pressed", "false");
    powerButton.querySelector(".power-text").textContent = "START";
    if (audio) {
      audio.stop();
      audio = null;
    }
  }
}

function seedFirstPulse() {
  [170, 174, 178, 104, 115, 42, 47, 132, 145].forEach((index, offset) => {
    window.setTimeout(() => {
      pads[index].heat = 0.7;
      pads[index].memory = Math.max(pads[index].memory, 0.42);
    }, offset * 42);
  });
}

function clearPattern() {
  pads.forEach((pad) => {
    pad.heat = 0;
    pad.memory = 0;
    pad.aura = 0;
  });
  gestureTrace = [];
  loopEvents = [];
  loopPulse = 0;
  document.documentElement.style.setProperty("--loop", "0");
  document.documentElement.style.setProperty("--loop-glow", "0px");
}

createPads();
resizeCanvas();
window.addEventListener("resize", resizeCanvas);
grid.addEventListener("pointerdown", onPointerDown);
grid.addEventListener("pointermove", onPointerMove);
grid.addEventListener("pointerup", onPointerUp);
grid.addEventListener("pointercancel", onPointerUp);
powerButton.addEventListener("click", togglePower);
clearButton.addEventListener("click", clearPattern);
holdButton.addEventListener("click", () => {
  holdLights = !holdLights;
  holdButton.setAttribute("aria-pressed", String(holdLights));
});
requestAnimationFrame(updateVisuals);
