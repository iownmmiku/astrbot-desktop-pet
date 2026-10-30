'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { petLayout, clampBounds, resizeAtFeet } = require('../src/geometry');
const { SpeechQueue, speechAllowed } = require('../src/speech_queue');
const { PetConnection, normalizeSettings, sanitizeState } = require('../src/core');
const initialState = () => ({ mood: 80, satiety: 80, cleanliness: 80, energy: 80, exp: 0, level: 1 });
const reply = (data, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => data });

test('2x model expands canvas without clipping and resize preserves feet', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  const normal = petLayout(1, area), large = petLayout(2, area);
  assert.equal(normal.width, 360); assert.equal(normal.height, 500);
  assert.equal(large.width, 675); assert.equal(large.height, 867);
  assert.ok(large.modelBoxWidth < large.canvasWidth);
  assert.ok(large.modelBoxHeight < large.canvasHeight);
  const old = { x: 1000, y: 560, width: normal.width, height: normal.height };
  const resized = resizeAtFeet(old, large, area);
  assert.equal(resized.y + resized.height, old.y + old.height);
  assert.ok(Math.abs(resized.x + resized.width / 2 - old.x - old.width / 2) <= 0.5);
});

test('small and negative-coordinate displays fit complete pet without changing requested scale', () => {
  const area = { x: -1280, y: -200, width: 1280, height: 680 };
  const layout = petLayout(2, area);
  assert.equal(layout.requestedScale, 2);
  assert.ok(layout.effectiveScale < 2);
  assert.ok(layout.width <= area.width && layout.height <= area.height);
  assert.ok(layout.modelBoxHeight <= layout.canvasHeight);
  const bounds = clampBounds({ x: -100, y: 800, width: layout.width, height: layout.height }, area);
  assert.ok(bounds.x >= area.x && bounds.x + bounds.width <= area.x + area.width);
  assert.ok(bounds.y >= area.y && bounds.y + bounds.height <= area.y + area.height);
  const small = petLayout(0.5, area);
  assert.equal(small.effectiveScale, 0.5);
  assert.ok(small.height < 500 && small.width >= 312);
});

test('direct replies queue without replacing unread chat, and chat outranks queued bot chatter', () => {
  let now = 1000;
  const queue = new SpeechQueue({ now: () => now });
  queue.push({ text: '第一条回复', source: 'chat', request_id: 'a', duration: 10000 });
  queue.push({ text: '平台推送', source: 'bot', request_id: 'b' });
  queue.push({ text: '第二条回复', source: 'chat', request_id: 'c' });
  assert.equal(queue.current.text, '第一条回复');
  assert.equal(queue.pending.length, 2);
  now += 10001; queue.tick();
  assert.equal(queue.current.text, '第二条回复');
  queue.dismiss(); assert.equal(queue.current.text, '平台推送');
});

test('chat preempts idle speech and displaced bot reply remains readable', () => {
  const queue = new SpeechQueue();
  queue.push({ text: '随便说说', source: 'chatter' });
  queue.push({ text: '聊天答复', source: 'chat' });
  assert.equal(queue.current.text, '聊天答复');
  assert.equal(queue.pending.length, 0);
  queue.dismiss(); queue.push({ text: '平台消息', source: 'bot' });
  queue.push({ text: '另一次聊天', source: 'chat' });
  assert.equal(queue.current.text, '另一次聊天');
  queue.dismiss(); assert.equal(queue.current.text, '平台消息');
});

test('idle speech coalesces, duplicate request IDs deduplicate, and quiet time preserves direct replies', () => {
  const queue = new SpeechQueue({ now: () => 1000 });
  queue.push({ text: '正在读的聊天', source: 'chat', request_id: 'one' });
  queue.push({ text: '旧闲聊', source: 'chatter' }); queue.push({ text: '新闲聊', source: 'sleepy' });
  assert.equal(queue.pending.length, 1); assert.equal(queue.pending[0].text, '新闲聊');
  assert.equal(queue.push({ text: '重复', source: 'chat', request_id: 'one' }), false);
  queue.setPolicy({ muteUntil: 2000 });
  assert.equal(queue.pending.length, 0);
  assert.equal(queue.current.text, '正在读的聊天');
  assert.equal(queue.push({ text: '推送', source: 'bot' }), false);
  assert.equal(queue.push({ text: '投喂答复', source: 'feed' }), true);
  assert.equal(speechAllowed({ muteUntil: 2000 }, 'bot', 2001), true);
  assert.equal(speechAllowed({ quietMode: true }, 'chat', 1000), true);
});

test('hovering pauses bubble expiry and resumes remaining reading time', () => {
  let now = 1000;
  const queue = new SpeechQueue({ now: () => now });
  queue.push({ text: '长回复', source: 'chat', duration: 10000 });
  now = 2000; queue.setPaused(true);
  now = 30000; queue.tick(); assert.ok(queue.current);
  queue.setPaused(false); now = 38000; queue.tick(); assert.ok(queue.current);
  now = 40000; queue.tick(); assert.equal(queue.current, null);
});

test('advancing a queued bubble under the pointer keeps reading paused', () => {
  let now = 1000;
  const queue = new SpeechQueue({ now: () => now });
  queue.push({ text: '第一条', source: 'chat', duration: 1000 });
  queue.push({ text: '第二条', source: 'chat', duration: 1000 });
  queue.setPaused(true); queue.dismiss(); now = 10000; queue.tick();
  assert.equal(queue.current.text, '第二条');
  queue.setPaused(false); now = 12000; queue.tick(); assert.equal(queue.current, null);
});

test('sleep fields remain optional for older plugins and local quiet settings validate', () => {
  assert.deepEqual(sanitizeState(initialState()), initialState());
  assert.equal(sanitizeState({ ...initialState(), is_sleeping: true, sleep_started_at: 100 }).is_sleeping, true);
  assert.equal(sanitizeState({ ...initialState(), is_sleeping: 'false', sleep_started_at: NaN }).sleep_started_at, null);
  const value = normalizeSettings({ quietMode: true, muteUntil: 123456789 });
  assert.equal(value.quietMode, true); assert.equal(value.muteUntil, 123456789);
  assert.throws(() => normalizeSettings({ quietMode: 'true' }));
  assert.throws(() => normalizeSettings({ muteUntil: Infinity }));
});

test('health timeout negotiation applies before long mutation and stays bounded', async () => {
  const calls = [];
  const connection = new PetConnection({ requestTimeout: 20, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/health')) return reply({ request_timeout_sec: 195 });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(options.signal.aborted, false);
    return reply({ reply: '完成', state: initialState(), request_id: 'slow' });
  } });
  await connection.chat('慢任务', 'slow');
  assert.equal(connection.requestTimeout, 200000);
  assert.equal(calls.length, 2);
  connection.negotiateTimeout(99999); assert.equal(connection.requestTimeout, 210000);
  connection.negotiateTimeout(NaN); assert.equal(connection.requestTimeout, 210000);
  connection.stop();
});

test('timeout retains request ID and explicit same-ID retry sends the same operation once per invocation', async () => {
  const ids = [];
  const connection = new PetConnection({ requestTimeout: 20, fetchImpl: (url, options) => {
    ids.push(JSON.parse(options.body).request_id);
    if (ids.length > 1) return reply({ reply: '恢复的回复', state: initialState(), request_id: ids.at(-1) });
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true }));
  } });
  connection.timeoutNegotiated = true;
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(connection.chat('原文', 'stable-id'), error => error.code === 'request_timeout' && error.request_id === 'stable-id');
    assert.deepEqual(ids, ['stable-id']);
    const result = await connection.chat('原文', 'stable-id');
    assert.equal(result.reply, '恢复的回复'); assert.deepEqual(ids, ['stable-id', 'stable-id']);
  } finally { clearInterval(keepAlive); connection.stop(); }
});

test('completed request lookup recovers reply and state exactly once', async () => {
  const connection = new PetConnection({ fetchImpl: () => reply({ status: 'completed', request_id: 'recover', result: { reply: '恢复成功', state: { ...initialState(), exp: 8 }, revision: 2, request_id: 'recover' } }) });
  const speech = []; connection.on('update', message => { if (message.type === 'speak') speech.push(message); });
  await connection.requestStatus('recover', 'chat'); await connection.requestStatus('recover', 'chat');
  assert.equal(connection.state.exp, 8); assert.equal(speech.length, 1); assert.equal(speech[0].source, 'chat');
  connection.stop();
});

test('API errors retain machine code, status, and caller request ID', async () => {
  const connection = new PetConnection({ fetchImpl: () => reply({ error: '此 ID 已用于其他文本', code: 'request_conflict' }, 409) });
  connection.timeoutNegotiated = true;
  await assert.rejects(connection.chat('文本', 'conflict'), error => error.code === 'request_conflict' && error.status === 409 && error.request_id === 'conflict');
  connection.stop();
});

test('quiet mode marks platform speech silent while preserving chat and record delivery', () => {
  const connection = new PetConnection({ speechPolicy: { quietMode: true } });
  const records = []; connection.on('update', item => records.push(item));
  connection.emitSpeech('平台消息', 'bot', 'bot-1'); connection.emitSpeech('主动聊天', 'chat', 'chat-1');
  assert.equal(records[0].silent, true); assert.equal(records[1].silent, false);
  connection.stop();
});

test('preload forwards retry IDs and preserves structured errors as cloneable records', async () => {
  let exposed;
  const calls = [];
  const sandbox = { require(name) {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld(_name, api) { exposed = api; } }, ipcRenderer: {
      invoke: async (...args) => { calls.push(args); return { ok: false, error: { name: 'PetError', message: '等待中', code: 'request_pending', status: 409, request_id: 'known-id' } }; }, on() {}, removeListener() {}
    } };
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8'), sandbox);
  await assert.rejects(exposed.chat('原文', 'known-id'), error => error.code === 'request_pending' && error.request_id === 'known-id' && error.status === 409);
  assert.deepEqual(calls[0], ['pet:chat', '原文', 'known-id']);
  assert.equal(typeof exposed.requestStatus, 'function'); assert.equal(exposed.invoke, undefined);
});
