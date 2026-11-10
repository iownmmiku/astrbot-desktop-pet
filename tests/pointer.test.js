'use strict';

// Click-through on transparent pixels and screen-wide gaze in the pet window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');

async function petPage(t, { live2d = false, alpha = 0 } = {}) {
  const listeners = [], through = [], focus = [];
  const dom = new JSDOM(source('pet.html'), { url: 'https://pet.local/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  t.after(() => w.close());
  w.setInterval = () => 0;
  const renderer = {
    handlers: {}, resolution: 1, alpha,
    on(name, fn) { (this.handlers[name] ||= []).push(fn); },
    listeners(name) { return this.handlers[name] || []; },
    resize() {},
    gl: { RGBA: 1, UNSIGNED_BYTE: 2, readPixels(x, y, width, height, format, type, pixels) { for (let i = 3; i < pixels.length; i += 4) pixels[i] = renderer.alpha; } }
  };
  if (live2d) {
    const vector = { set() {} };
    const model = { internalModel: { width: 300, height: 400, motionManager: { definitions: {} } }, scale: vector, anchor: vector, position: vector,
      destroy() {}, focus: (x, y) => focus.push([x, y]), motion: async () => {}, expression: async () => {} };
    w.PIXI = { Application: class { constructor() { this.stage = { addChild() {}, removeChild() {} }; this.renderer = renderer; this.ticker = {}; } stop() {} start() {} },
      live2d: { Live2DModel: { from: async () => model } } };
    w.Live2DCubismCore = {};
  }
  w.petAPI = {
    onUpdate: fn => listeners.push(fn),
    snapshot: async () => ({ settings: { model: live2d ? { url: 'petmodel://local/a.model3.json', path: 'a' } : { url: '' } }, status: { phase: 'online' }, state: { is_sleeping: false }, config: {} }),
    setMouseThrough: async ignore => { through.push(ignore); return ignore; },
    openControl: async () => {}, openQuickChat: async () => {}, dragStart: async () => {}, dragStop: async () => {}, petActive: async () => {}, action: async () => {}
  };
  w.eval(source('speech_queue.js'));
  w.eval(source('pet.js'));
  await tick(); await tick();
  const byId = id => w.document.getElementById(id);
  let under = null;
  w.document.elementFromPoint = () => under;
  return {
    w, byId, through, focus, renderer,
    emit: message => listeners.forEach(fn => fn(message)),
    hover(element, x = 100, y = 200) { under = element; w.document.dispatchEvent(new w.MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true })); },
    render() { renderer.listeners('postrender').forEach(fn => fn()); }
  };
}

test('fallback cat takes the mouse only on painted shapes and reports changes once', async t => {
  const page = await petPage(t);
  const svg = page.byId('fallback').querySelector('svg'), shape = svg.querySelector('ellipse');
  page.hover(shape); assert.deepEqual(page.through, [false]);
  page.hover(svg); assert.deepEqual(page.through, [false, true]);
  page.hover(page.byId('pet-stage')); assert.deepEqual(page.through, [false, true], 'unchanged decisions are not resent');
  page.hover(page.byId('open-control')); assert.deepEqual(page.through, [false, true, false]);
});

test('speech bubble stays interactive while transparent window areas pass through', async t => {
  const page = await petPage(t);
  page.hover(null); assert.deepEqual(page.through, [true]);
  page.hover(page.byId('speech-text')); assert.deepEqual(page.through, [true, false]);
});

test('Live2D hit testing waits for the rendered frame and follows pixel alpha', async t => {
  const page = await petPage(t, { live2d: true, alpha: 0 });
  const canvas = page.byId('live2d');
  assert.equal(canvas.hidden, false);
  assert.equal(page.renderer.listeners('postrender').length, 1);
  page.hover(canvas); assert.deepEqual(page.through, [], 'canvas decisions wait for a rendered frame');
  page.render(); assert.deepEqual(page.through, [true]);
  page.renderer.alpha = 255;
  page.hover(canvas); page.render(); assert.deepEqual(page.through, [true, false]);
  page.render(); assert.deepEqual(page.through, [true, false], 'no sample is read without a new hover');
});

test('dragging never turns on click-through mid-gesture', async t => {
  const page = await petPage(t, { live2d: true, alpha: 255 });
  const stage = page.byId('pet-stage');
  stage.setPointerCapture = () => {};
  stage.dispatchEvent(new page.w.PointerEvent('pointerdown', { button: 0, screenX: 5, screenY: 5, bubbles: true }));
  page.renderer.alpha = 0;
  page.hover(null); page.render();
  assert.deepEqual(page.through, []);
});

test('screen-wide gaze focuses the model relative to the canvas and rests while asleep', async t => {
  const page = await petPage(t, { live2d: true });
  page.emit({ type: 'gaze', x: -300, y: 40 });
  assert.deepEqual(page.focus, [[-300, 40]]);
  page.emit({ type: 'state', data: { is_sleeping: true } });
  page.emit({ type: 'gaze', x: 10, y: 10 });
  page.emit({ type: 'gaze', x: 'bad', y: 10 });
  assert.deepEqual(page.focus, [[-300, 40]]);
});
