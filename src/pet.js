'use strict';

const api = window.petAPI;
const $ = id => document.getElementById(id);
let settings = {}, config = {}, state = null, application = null, model = null, modelKey = '', loadGeneration = 0;
let lastSpeech = 0, lastInteraction = Date.now(), chatterTimer, clickTimer, pointer = null;
let baseWidth = 1, baseHeight = 1;
let companionFullscreen = false, speechHovered = false;
let layout = { width: 360, height: 500, canvasWidth: 360, canvasHeight: 390, modelBoxWidth: 315, modelBoxHeight: 367, footY: 384, effectiveScale: 1 };
const speechQueue = new PetSpeech.SpeechQueue({ onChange: ({ current, pending, paused }) => {
  $('speech').hidden = !current || companionFullscreen;
  if (current) {
    if ($('speech-text').textContent !== current.text) $('speech-text').textContent = current.text;
    $('speech-count').textContent = pending ? `还有 ${pending} 条` : paused ? '阅读中 · 移开鼠标后继续' : '移入气泡可暂停消失';
    $('next-speech').hidden = pending === 0;
  }
} });
setInterval(() => speechQueue.tick(), 250);

function speak(text, duration, source = 'notice', request_id, silent = false) {
  if (speechQueue.push({ text, duration, source, request_id, silent })) lastSpeech = Date.now();
}

function pauseSpeech() { speechQueue.setPaused(companionFullscreen || speechHovered || document.hidden); }

function applyCompanionMode(mode) {
  companionFullscreen = mode?.fullscreen === true;
  pauseSpeech();
  $('speech').hidden = companionFullscreen || !speechQueue.current;
  if (!companionFullscreen) lastInteraction = Date.now();
}

function applyLayout(next) {
  if (!next || !Number.isFinite(next.width) || !Number.isFinite(next.canvasHeight)) return;
  layout = next;
  const style = document.documentElement.style;
  style.setProperty('--pet-width', `${layout.width}px`);
  style.setProperty('--pet-height', `${layout.height}px`);
  style.setProperty('--canvas-height', `${layout.canvasHeight}px`);
  style.setProperty('--fallback-width', `${284 * layout.effectiveScale}px`);
  style.setProperty('--fallback-height', `${318 * layout.effectiveScale}px`);
  if (application) application.renderer.resize(layout.canvasWidth, layout.canvasHeight);
  fitModel();
}

function fitModel() {
  if (!model) return;
  const scale = Math.min(layout.modelBoxWidth / baseWidth, layout.modelBoxHeight / baseHeight);
  model.scale.set(scale); model.anchor.set(0.5, 1); model.position.set(layout.width / 2, layout.footY);
}

async function loadModel() {
  const url = settings.model?.url || '';
  const key = `${url}|${settings.model?.path || ''}`;
  if (modelKey === key) { fitModel(); return; }
  modelKey = key; const generation = ++loadGeneration;
  if (model) { application.stage.removeChild(model); model.destroy(); model = null; }
  $('fallback').hidden = false; $('live2d').hidden = true;
  if (!url) return;
  try {
    if (!window.PIXI?.live2d?.Live2DModel || !window.Live2DCubismCore) throw new Error('缺少 Live2D 运行组件');
    if (!application) application = new PIXI.Application({ view: $('live2d'), width: layout.canvasWidth, height: layout.canvasHeight, resolution: Math.min(window.devicePixelRatio || 1, 2), autoDensity: true, backgroundAlpha: 0, antialias: true });
    const nextModel = await PIXI.live2d.Live2DModel.from(url, { autoInteract: false });
    if (generation !== loadGeneration) { nextModel.destroy(); return; }
    model = nextModel;
    baseWidth = model.internalModel?.width || model.width || 1;
    baseHeight = model.internalModel?.height || model.height || 1;
    application.stage.addChild(model); fitModel();
    $('live2d').hidden = false; $('fallback').hidden = true;
    application.ticker.maxFPS = 30;
    applySleepState();
  } catch (error) {
    if (generation !== loadGeneration) return;
    $('fallback').hidden = false; $('live2d').hidden = true;
    speak(`模型加载失败，先用小猫陪你。\n${error.message}`, 20000);
    console.error('Live2D model loading failed:', error);
  }
}

function playMotion(action) {
  if (!model) return false;
  const groups = Object.keys(model.internalModel?.motionManager?.definitions || {});
  const patterns = {
    sleep: /sleep|rest|寝|眠/i, wake: /wake|awake|起床/i,
    walk: /walk|move|run|歩/i, idle: /^idle$|stand|待機/i,
    feed: /eat|feed|食/i, clean: /clean|bath|wash|洗/i,
    play: /tap.?body|touch|pat|摸/i, poke: /tap|touch|flick|戳/i
  };
  const group = groups.find(name => patterns[action]?.test(name));
  if (!group) return false;
  Promise.resolve(model.motion(group)).catch(() => {});
  return true;
}

function applySleepState(previousSleeping) {
  const sleeping = state?.is_sleeping === true;
  $('sleep-badge').hidden = !sleeping;
  $('fallback').classList.toggle('sleeping', sleeping);
  if (sleeping !== previousSleeping) playMotion(sleeping ? 'sleep' : 'wake');
  if (sleeping) speechQueue.clearPassive();
}

function interactVisual(action = 'poke') {
  if (model) {
    if (!playMotion(action) && ['play', 'poke'].includes(action) && !state?.is_sleeping) Promise.resolve(model.expression()).catch(() => {});
  } else {
    $('fallback').classList.remove('happy'); void $('fallback').offsetWidth; $('fallback').classList.add('happy');
  }
}

function scheduleChatter() {
  clearTimeout(chatterTimer);
  const seconds = Math.max(5, Math.min(86400, Number(config.chatter_interval_sec) || 90));
  chatterTimer = setTimeout(() => {
    const elapsed = Date.now() - Math.max(lastSpeech, lastInteraction);
    if (!companionFullscreen && !document.hidden && config.enable_chatter && !state?.is_sleeping && PetSpeech.speechAllowed(settings, 'chatter') && elapsed >= seconds * 1000 && !pointer) {
      const sleepy = state && state.energy < Number(config.sleepy_threshold ?? 20);
      const candidates = sleepy ? config.sleepy_lines : config.chatter_lines;
      const lines = Array.isArray(candidates) ? candidates.filter(line => typeof line === 'string' && line.trim()) : [];
      if (lines.length) speak(lines[Math.floor(Math.random() * lines.length)], undefined, sleepy ? 'sleepy' : 'chatter');
    }
    scheduleChatter();
  }, seconds * 1000);
}

$('dismiss-speech').addEventListener('click', () => speechQueue.dismiss());
$('next-speech').addEventListener('click', () => speechQueue.dismiss());
$('speech').addEventListener('mouseenter', () => { speechHovered = true; pauseSpeech(); });
$('speech').addEventListener('mouseleave', () => { speechHovered = false; pauseSpeech(); });
$('open-control').addEventListener('click', () => api.openControl().catch(error => speak(error.message)));
$('pet-stage').addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  pointer = { x: event.screenX, y: event.screenY, moved: false };
  event.currentTarget.setPointerCapture(event.pointerId);
  lastInteraction = Date.now();
  api.dragStart().catch(error => speak(error.message));
});
$('pet-stage').addEventListener('pointermove', event => {
  if (pointer && Math.hypot(event.screenX - pointer.x, event.screenY - pointer.y) > 4) pointer.moved = true;
  if (model && !pointer) model.focus(event.offsetX, event.offsetY);
});
function stopPointer(event) {
  if (!pointer) return;
  const clicked = !pointer.moved && event.type === 'pointerup'; pointer = null;
  api.dragStop().catch(() => {}); api.petActive().catch(() => {});
  if (clicked) {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; api.openQuickChat().catch(error => speak(error.message)); }
    else clickTimer = setTimeout(() => {
      clickTimer = null; interactVisual();
      api.action('poke').catch(error => speak(error.message));
    }, 270);
  }
}
$('pet-stage').addEventListener('pointerup', stopPointer);
$('pet-stage').addEventListener('pointercancel', stopPointer);
$('pet-stage').addEventListener('lostpointercapture', stopPointer);
$('pet-stage').addEventListener('contextmenu', event => { event.preventDefault(); api.openControl().catch(error => speak(error.message)); });
window.addEventListener('blur', () => { if (pointer) { pointer = null; api.dragStop().catch(() => {}); } });
document.addEventListener('visibilitychange', () => { pauseSpeech(); if (application) document.hidden ? application.stop() : application.start(); });

api.onUpdate(message => {
  if (message.type === 'speak') { speak(message.text, undefined, message.source, message.request_id, message.silent); if (['feed', 'play', 'poke', 'clean'].includes(message.source)) interactVisual(message.source); }
  else if (message.type === 'state') { const sleeping = state?.is_sleeping; state = message.data; applySleepState(sleeping); }
  else if (message.type === 'config') { config = message.data; scheduleChatter(); }
  else if (message.type === 'settings') { settings = message.data; speechQueue.setPolicy(settings); applyLayout(settings.layout); loadModel(); }
  else if (message.type === 'layout') applyLayout(message.data);
  else if (message.type === 'motion') playMotion(message.state);
  else if (message.type === 'companion_mode') applyCompanionMode(message.data);
  else if (message.type === 'notice') speak(message.text);
  else if (message.type === 'status') { $('pet-status').className = message.data.phase; $('pet-status').title = message.data.message; }
});
api.snapshot().then(data => {
  settings = data.settings; config = data.config; state = data.state;
  if (data.companionMode) applyCompanionMode(data.companionMode);
  speechQueue.setPolicy(settings); applyLayout(settings.layout); applySleepState();
  $('pet-status').className = data.status.phase; $('pet-status').title = data.status.message;
  loadModel(); scheduleChatter();
}).catch(error => speak(error.message));
