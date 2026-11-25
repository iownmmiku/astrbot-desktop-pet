'use strict';

// Click-through on transparent pixels and screen-wide gaze in the pet window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');

// Haru-like expressions: smiling mouth, angry/crying, smiling eyes, sulking.
const EXPRESSIONS = {
  'exp/F01.exp3.json': [{ Id: 'ParamMouthForm', Value: 0.27 }],
  'exp/F03.exp3.json': [{ Id: 'ParamMouthForm', Value: -2 }, { Id: 'ParamMouthOpenY', Value: 1 }],
  'exp/F05.exp3.json': [{ Id: 'ParamEyeLOpen', Value: 0, Blend: 'Multiply' }, { Id: 'ParamEyeLSmile', Value: 1 }, { Id: 'ParamEyeRSmile', Value: 1 }],
  'exp/F06.exp3.json': [{ Id: 'ParamEyeLOpen', Value: 2, Blend: 'Multiply' }, { Id: 'ParamMouthForm', Value: -0.4 }]
};

async function petPage(t, { live2d = false, alpha = 0, hitAreas = [] } = {}) {
  const listeners = [], through = [], focus = [], actions = [], expressions = [], params = [], motions = [], looks = [];
  let resets = 0;
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
  let model = null;
  if (live2d) {
    const vector = { set() {} }, handlers = {};
    const json = { Groups: [{ Name: 'EyeBlink', Ids: ['EyeL', 'EyeR'] }], FileReferences: { Expressions: Object.keys(EXPRESSIONS).map(File => ({ File })) } };
    model = { internalModel: { width: 300, height: 400, settings: { json },
      motionManager: { definitions: { Idle: [{}], TapBody: [{}] }, expressionManager: { resetExpression: () => { resets++; } } },
      focusController: { focus: (x, y) => looks.push([x, y]) },
      coreModel: { setParameterValueById: (id, value) => params.push([id, value]) },
      on: (name, fn) => { (handlers[name] ||= []).push(fn); }, emit: name => (handlers[name] || []).forEach(fn => fn()) },
      scale: vector, anchor: vector, position: vector, hitTest: () => hitAreas,
      destroy() {}, focus: (x, y) => focus.push([x, y]), motion: async group => { motions.push(group); }, expression: async index => { expressions.push(index); } };
    w.fetch = async url => ({ json: async () => ({ Parameters: EXPRESSIONS[String(url).replace('petmodel://local/', '')] }) });
    w.PIXI = { Application: class { constructor() { this.stage = { addChild() {}, removeChild() {} }; this.renderer = renderer; this.ticker = {}; } stop() {} start() {} },
      live2d: { Live2DModel: { from: async () => model } } };
    w.Live2DCubismCore = {};
  }
  w.petAPI = {
    onUpdate: fn => listeners.push(fn),
    snapshot: async () => ({ settings: { model: live2d ? { url: 'petmodel://local/a.model3.json', path: 'a' } : { url: '' } }, status: { phase: 'online' }, state: { is_sleeping: false }, config: {} }),
    setMouseThrough: async ignore => { through.push(ignore); return ignore; },
    openControl: async () => {}, openQuickChat: async () => {}, dragStart: async () => {}, dragStop: async () => {}, petActive: async () => {}, action: async action => { actions.push(action); }
  };
  w.eval(source('speech_queue.js'));
  w.eval(source('pet.js'));
  for (let i = 0; i < 5; i++) await tick();
  const byId = id => w.document.getElementById(id);
  let under = null;
  w.document.elementFromPoint = () => under;
  return {
    w, byId, through, focus, renderer, actions, expressions, params, motions, looks, model, resets: () => resets,
    emit: message => listeners.forEach(fn => fn(message)),
    async click(target = byId('pet-stage'), x = 100, y = 100) {
      target.setPointerCapture = () => {};
      target.dispatchEvent(new w.PointerEvent('pointerdown', { button: 0, clientX: x, clientY: y, screenX: x, screenY: y, bubbles: true }));
      target.dispatchEvent(new w.PointerEvent('pointerup', { button: 0, clientX: x, clientY: y, screenX: x, screenY: y, bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 320));
    },
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

test('expressions are classified from their parameters: play is happy, poke is never angry', async t => {
  const page = await petPage(t, { live2d: true });
  // Index order: F01 smile (0), F03 angry (1), F05 smiling eyes (2), F06 surprised (3).
  for (let i = 0; i < 20; i++) { page.emit({ type: 'speak', text: '好', source: i % 2 ? 'feed' : 'clean' }); page.w.Date.now = (() => { const now = Date.now() + (i + 1) * 2000; return () => now; })(); }
  assert.ok(page.expressions.length > 0);
  assert.ok(page.expressions.every(index => [0, 2].includes(index)), `happy reactions only: ${page.expressions}`);
  page.expressions.length = 0;
  for (let i = 0; i < 20; i++) { page.emit({ type: 'speak', text: '呀', source: 'poke' }); page.w.Date.now = (() => { const now = Date.now() + (i + 50) * 2000; return () => now; })(); }
  assert.ok(page.expressions.every(index => index !== 1), 'the angry/crying face is never used for a poke');
  assert.ok(page.motions.includes('TapBody'), 'models with a tap motion still play it');
});

test('a reaction from a click is not replayed by the server echo of the same action', async t => {
  const page = await petPage(t, { live2d: true, hitAreas: ['Body'] });
  await page.click();
  assert.deepEqual(page.actions, ['poke']);
  assert.equal(page.expressions.length, 1);
  page.emit({ type: 'speak', text: '呀！', source: 'poke', request_id: 'r1' });
  assert.equal(page.expressions.length, 1);
});

test('clicking a Live2D head pets and clicking the body pokes', async t => {
  const head = await petPage(t, { live2d: true, hitAreas: ['Head'] });
  await head.click(); assert.deepEqual(head.actions, ['play']);
  const body = await petPage(t, { live2d: true, hitAreas: [] });
  await body.click(); assert.deepEqual(body.actions, ['poke']);
});

test('clicking the built-in cat head pets and its body pokes', async t => {
  const page = await petPage(t);
  const svg = page.byId('fallback').querySelector('svg');
  svg.getBoundingClientRect = () => ({ left: 0, top: 100, width: 284, height: 318 });
  await page.click(page.byId('pet-stage'), 140, 150); assert.deepEqual(page.actions, ['play']);
  await page.click(page.byId('pet-stage'), 140, 390); assert.deepEqual(page.actions, ['play', 'poke']);
});

test('sleeping closes the eyes every frame, drops the head and wakes with a smile', async t => {
  const page = await petPage(t, { live2d: true });
  page.model.internalModel.emit('beforeModelUpdate');
  assert.deepEqual(page.params, [], 'awake eyes are left to blinking');
  const resets = page.resets();
  page.emit({ type: 'state', data: { is_sleeping: true } });
  assert.ok(page.resets() > resets, 'any reaction face is cleared when falling asleep');
  assert.deepEqual(page.looks.at(-1), [0, -0.6]);
  page.model.internalModel.emit('beforeModelUpdate');
  assert.deepEqual(page.params, [['EyeL', 0], ['EyeR', 0]]);
  page.emit({ type: 'speak', text: '好吃', source: 'feed' });
  assert.equal(page.expressions.length, 0, 'no reaction faces while asleep');
  page.emit({ type: 'state', data: { is_sleeping: false } });
  assert.ok([0, 2].includes(page.expressions.at(-1)), 'waking up shows a happy face');
  page.params.length = 0; page.model.internalModel.emit('beforeModelUpdate');
  assert.deepEqual(page.params, []);
});
