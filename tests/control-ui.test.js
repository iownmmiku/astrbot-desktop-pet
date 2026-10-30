'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function screen(t, overrides = {}) {
  const listeners = [];
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../src/control.html'), 'utf8'), {
    url: 'https://pet.local/', runScripts: 'outside-only', pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.confirm = () => true;
  w.crypto.randomUUID = randomUUID;
  const api = {
    onUpdate(fn) { listeners.push(fn); },
    snapshot: async () => ({ settings: { server: 'http://127.0.0.1:9898', scale: 1, alwaysOnTop: true }, status: { phase: 'online' }, state: null, config: {}, appVersion: '0.8.0' }),
    ...overrides
  };
  w.petAPI = api;
  w.eval(fs.readFileSync(path.join(__dirname, '../src/control.js'), 'utf8'));
  await tick();
  const byId = id => w.document.getElementById(id);
  const emit = event => listeners.forEach(fn => fn(event));
  const submit = id => byId(id).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  return { w, byId, emit, submit };
}

test('chat retry retains the request ID and does not duplicate the original user message', async t => {
  const calls = [];
  const ui = await screen(t, { chat: async (text, id) => { calls.push({ text, id }); throw { message: '连接超时', request_id: id }; } });
  ui.byId('chat-input').value = '周末一起去了海边'; ui.submit('chat-form'); await tick();
  assert.equal(ui.byId('chat-recovery').hidden, false);
  assert.equal(ui.byId('chat-input').value, '周末一起去了海边');
  ui.byId('retry-chat').click(); await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].id, calls[1].id);
  assert.equal(ui.w.document.querySelectorAll('.message.user').length, 1);
});

test('a WS reply arriving before the HTTP timeout is treated as delivered, without retry UI', async t => {
  let reject, requestId;
  const ui = await screen(t, { chat: (text, id) => { requestId = id; return new Promise((_, no) => { reject = no; }); } });
  ui.byId('chat-input').value = '回忆一下昨天'; ui.submit('chat-form');
  ui.emit({ type: 'speak', source: 'chat', scope: 'one', request_id: requestId, text: '昨天我们去看了海。' });
  reject({ message: 'HTTP 超时', request_id: requestId }); await tick();
  assert.equal(ui.byId('chat-recovery').hidden, true);
  assert.equal(ui.w.document.querySelectorAll('.message.error').length, 0);
  assert.equal(ui.byId('chat-input').value, '');
  ui.emit({ type: 'speak', source: 'chat', scope: 'one', request_id: requestId, text: '昨天我们去看了海。' });
  assert.equal(ui.w.document.querySelectorAll('.message.assistant').length, 1);
});

test('changing server clears pending recovery and ignores the old request failure', async t => {
  let reject;
  const ui = await screen(t, { chat: () => new Promise((_, no) => { reject = no; }) });
  ui.byId('chat-input').value = '旧服务器问题'; ui.submit('chat-form');
  ui.emit({ type: 'connection_changed', server: 'https://new.example.com' });
  reject({ message: '旧请求错误' }); await tick();
  assert.equal(ui.byId('messages').children.length, 0);
  assert.equal(ui.byId('chat-recovery').hidden, true);
  assert.equal(ui.byId('send-chat').disabled, false);
});

test('sleep state changes the same control into a wake action', async t => {
  const actions = [];
  const ui = await screen(t, { action: async name => { actions.push(name); } });
  const state = { mood: 80, satiety: 80, cleanliness: 80, energy: 20, level: 1, exp: 0, is_sleeping: true };
  ui.emit({ type: 'state', data: state });
  assert.equal(ui.byId('sleep-action').querySelector('b').textContent, '唤醒');
  ui.byId('sleep-action').click(); await tick();
  assert.deepEqual(actions, ['wake']);
  ui.emit({ type: 'state', data: { ...state, is_sleeping: false } });
  assert.equal(ui.byId('sleep-action').dataset.action, 'sleep');
});

test('quiet mode, timed silence and resume save independent local controls', async t => {
  const saves = [];
  const ui = await screen(t, { saveSettings: async value => { saves.push(value); return value; } });
  ui.byId('quiet-mode').checked = true; ui.submit('quiet-form'); await tick();
  assert.equal(saves[0].quietMode, true);
  const before = Date.now(); ui.byId('quiet-hour').click(); await tick();
  assert.ok(saves[1].muteUntil >= before + 3600000);
  ui.byId('quiet-resume').click(); await tick();
  assert.equal(saves[2].quietMode, false); assert.equal(saves[2].muteUntil, 0);
});
