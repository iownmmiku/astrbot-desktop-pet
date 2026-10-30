'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

async function screen(t, overrides = {}, page = 'quickchat') {
  const listeners = [], intervals = [];
  const dom = new JSDOM(source(`${page}.html`), { url: 'https://pet.local/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  t.after(() => dom.window.close());
  w.crypto.randomUUID = randomUUID;
  w.setInterval = callback => { intervals.push(callback); return intervals.length; };
  const api = {
    onUpdate(fn) { listeners.push(fn); },
    snapshot: async () => ({ settings: { server: 'http://127.0.0.1:9898' }, status: { phase: 'online' }, state: null, config: {}, petName: '小花' }),
    closeQuickChat: async () => {}, openQuickChat: async () => {}, openControl: async () => {}, copyText: async () => {},
    dragStart: async () => {}, dragStop: async () => {}, petActive: async () => {}, action: async () => {},
    ...overrides
  };
  w.petAPI = api;
  if (page === 'pet') w.eval(source('speech_queue.js'));
  w.eval(source(`${page}.js`));
  await tick();
  const byId = id => w.document.getElementById(id);
  return {
    w, byId, intervals,
    emit: event => listeners.forEach(fn => fn(event)),
    type(text) { byId('chat-input').value = text; byId('chat-input').dispatchEvent(new w.Event('input', { bubbles: true })); },
    submit() { byId('chat-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); },
    key(key, options = {}, target = byId('chat-input')) { const event = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }); target.dispatchEvent(event); return event; }
  };
}

test('quick chat sends Enter once and leaves Shift+Enter and IME confirmation to the editor', async t => {
  const calls = [], response = deferred();
  const ui = await screen(t, { chat: (text, id) => { calls.push({ text, id }); return response.promise; } });
  ui.type('你好，桌宠');
  assert.equal(ui.key('Enter', { shiftKey: true }).defaultPrevented, false);
  ui.key('Enter', { isComposing: true });
  ui.key('Enter', { keyCode: 229 });
  ui.byId('chat-input').dispatchEvent(new ui.w.CompositionEvent('compositionstart'));
  ui.key('Enter'); ui.submit();
  assert.equal(calls.length, 0);
  ui.byId('chat-input').dispatchEvent(new ui.w.CompositionEvent('compositionend'));
  ui.key('Enter');
  assert.equal(calls.length, 0, 'compositionend followed immediately by Enter must not send');
  const now = Date.now(); ui.w.Date.now = () => now + 200;
  assert.equal(ui.key('Enter').defaultPrevented, true);
  ui.key('Enter'); ui.submit();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, '你好，桌宠');
  assert.equal(ui.byId('send-chat').disabled, true);
  response.resolve({ reply: '你好' }); await tick();
});

test('Escape hides without losing a new draft or interrupting the pending reply', async t => {
  let closed = 0, id;
  const response = deferred();
  const ui = await screen(t, { closeQuickChat: async () => { closed++; }, chat: (_text, requestId) => { id = requestId; return response.promise; } });
  ui.type('第一句话'); ui.submit(); ui.type('还没发出的下一句');
  ui.key('Escape'); await tick();
  assert.equal(closed, 1); assert.equal(ui.byId('chat-input').value, '还没发出的下一句');
  assert.equal(ui.byId('send-chat').disabled, true);
  ui.emit({ type: 'speak', source: 'chat', request_id: id, text: '我在听。' });
  response.resolve({ reply: '我在听。' }); await tick();
  assert.equal(ui.byId('chat-input').value, '还没发出的下一句');
  assert.equal(ui.byId('send-chat').disabled, false);
  assert.equal(ui.w.document.querySelectorAll('.message.assistant').length, 1);
  ui.emit({ type: 'quickchat_opened' });
  assert.equal(ui.w.document.activeElement, ui.byId('chat-input'));
});

test('Escape does not close during input method composition', async t => {
  let closed = 0;
  const ui = await screen(t, { closeQuickChat: async () => { closed++; } });
  ui.byId('chat-input').dispatchEvent(new ui.w.CompositionEvent('compositionstart'));
  ui.key('Escape'); ui.key('Escape', { isComposing: true });
  await tick(); assert.equal(closed, 0);
});

test('manual retry keeps the same ID and original text without overwriting a newer draft', async t => {
  const calls = [];
  const ui = await screen(t, { chat: async (text, id) => { calls.push({ text, id }); throw { code: 'request_timeout', message: '等待超时', request_id: id }; } });
  ui.type('原来的问题'); ui.submit(); await tick();
  assert.equal(ui.byId('chat-recovery').hidden, false);
  ui.type('我正在写的新草稿'); ui.byId('retry-chat').click(); await tick();
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
  assert.equal(ui.byId('chat-input').value, '我正在写的新草稿');
  assert.equal(ui.w.document.querySelectorAll('.message.user').length, 1);
});

test('a real-time reply before HTTP timeout is displayed once without failed recovery', async t => {
  const response = deferred(); let id;
  const ui = await screen(t, { chat: (_text, requestId) => { id = requestId; return response.promise; } });
  ui.type('今天过得怎么样'); ui.submit();
  ui.emit({ type: 'speak', source: 'chat', request_id: id, text: '今天很好。' });
  ui.emit({ type: 'speak', source: 'chat', request_id: id, text: '今天很好。' });
  response.reject({ code: 'request_timeout', message: 'HTTP 超时', request_id: id }); await tick();
  assert.equal(ui.w.document.querySelectorAll('.message.assistant').length, 1);
  assert.equal(ui.byId('chat-recovery').hidden, true);
  assert.equal(ui.byId('chat-input').value, '');
  assert.match(ui.byId('chat-status').textContent, /已经|已通过/);
});

test('checking completed requests uses status lookup and the shared speech stream, never another chat', async t => {
  let ui, id, chats = 0, checks = 0;
  ui = await screen(t, {
    chat: async (_text, requestId) => { chats++; id = requestId; throw { message: '请求结果未知' }; },
    requestStatus: async (requestId, kind) => {
      checks++; assert.equal(requestId, id); assert.equal(kind, 'chat');
      ui.emit({ type: 'speak', source: 'chat', request_id: id, text: '已经答好了。' });
      return { status: 'completed', result: { reply: '已经答好了。', request_id: id } };
    }
  });
  ui.type('查一下结果'); ui.submit(); await tick();
  ui.byId('check-chat').click(); await tick();
  assert.equal(chats, 1); assert.equal(checks, 1);
  assert.equal(ui.byId('chat-recovery').hidden, true);
  assert.equal(ui.byId('chat-input').value, '');
  assert.equal(ui.w.document.querySelectorAll('.message.assistant').length, 1);
});

test('pending or expired status never automatically resends a request', async t => {
  let chats = 0, nextStatus = 'pending';
  const ui = await screen(t, { chat: async () => { chats++; throw { message: '等待超时' }; }, requestStatus: async () => ({ status: nextStatus }) });
  ui.type('正在想的事情'); ui.submit(); await tick();
  ui.byId('check-chat').click(); await tick();
  assert.match(ui.byId('recovery-note').textContent, /还在处理/);
  nextStatus = 'unknown'; ui.byId('check-chat').click(); await tick();
  assert.match(ui.byId('recovery-note').textContent, /过期或服务重启/);
  assert.equal(chats, 1); assert.equal(ui.byId('chat-recovery').hidden, false);
});

test('changing connection isolates late replies and failures while preserving the typed draft', async t => {
  const response = deferred(); let id;
  const ui = await screen(t, { chat: (_text, requestId) => { id = requestId; return response.promise; } });
  ui.type('旧服务器的问题'); ui.submit(); ui.type('未发草稿');
  ui.emit({ type: 'connection_changed', server: 'https://new.example.test' });
  ui.emit({ type: 'speak', source: 'chat', request_id: id, text: '不应出现的旧回复' });
  response.reject({ message: '旧服务器超时' }); await tick();
  assert.equal(ui.byId('messages').children.length, 0);
  assert.equal(ui.byId('chat-input').value, '未发草稿');
  assert.equal(ui.byId('chat-recovery').hidden, true); assert.equal(ui.byId('send-chat').disabled, false);
  assert.doesNotMatch(ui.byId('chat-status').textContent, /超时/);
});

test('recent messages are bounded and model text is treated as text, not HTML', async t => {
  const ui = await screen(t);
  for (let i = 0; i < 12; i++) ui.emit({ type: 'speak', source: 'chat', request_id: `reply-${i}`, text: `<img src=x onerror=alert(1)> ${i}` });
  assert.equal(ui.byId('messages').children.length, 8);
  assert.equal(ui.byId('messages').querySelector('img'), null);
  assert.match(ui.byId('messages').textContent, /<img src=x/);
  assert.equal(ui.byId('empty-state').hidden, true);
});

test('pet double click opens quick chat while right click and flower retain the full control panel', async t => {
  let quick = 0, control = 0, actions = 0;
  const ui = await screen(t, { openQuickChat: async () => { quick++; }, openControl: async () => { control++; }, action: async () => { actions++; } }, 'pet');
  const stage = ui.byId('pet-stage'); stage.setPointerCapture = () => {};
  for (let i = 0; i < 2; i++) {
    stage.dispatchEvent(new ui.w.MouseEvent('pointerdown', { button: 0, screenX: 100, screenY: 100 }));
    stage.dispatchEvent(new ui.w.MouseEvent('pointerup', { button: 0, screenX: 100, screenY: 100 }));
  }
  stage.dispatchEvent(new ui.w.MouseEvent('contextmenu', { cancelable: true })); ui.byId('open-control').click(); await tick();
  assert.equal(quick, 1); assert.equal(control, 2); assert.equal(actions, 0);
});

test('fullscreen mode preserves direct bubbles and their reading time until returning', async t => {
  const ui = await screen(t, {}, 'pet');
  let now = 100000; ui.w.Date.now = () => now;
  ui.emit({ type: 'speak', source: 'chat', request_id: 'one', text: '第一条回复' });
  ui.emit({ type: 'companion_mode', data: { fullscreen: true } });
  ui.emit({ type: 'speak', source: 'chat', request_id: 'two', text: '全屏时到达的第二条回复' });
  assert.equal(ui.byId('speech').hidden, true);
  now += 600000; ui.intervals.forEach(callback => callback());
  ui.emit({ type: 'companion_mode', data: { fullscreen: false } });
  assert.equal(ui.byId('speech').hidden, false);
  assert.equal(ui.byId('speech-text').textContent, '第一条回复');
  ui.intervals.forEach(callback => callback());
  assert.equal(ui.byId('speech-text').textContent, '第一条回复', 'hidden time must not consume the reading duration');
  ui.byId('next-speech').click();
  assert.equal(ui.byId('speech-text').textContent, '全屏时到达的第二条回复');
});

test('a direct reply first arriving during fullscreen remains queued after an arbitrarily long wait', async t => {
  const ui = await screen(t, {}, 'pet');
  let now = 100000; ui.w.Date.now = () => now;
  ui.emit({ type: 'companion_mode', data: { fullscreen: true } });
  ui.emit({ type: 'speak', source: 'chat', request_id: 'new', text: '稍后再看也没有关系。' });
  now += 600000; ui.intervals.forEach(callback => callback());
  assert.equal(ui.byId('speech').hidden, true);
  ui.emit({ type: 'companion_mode', data: { fullscreen: false } });
  assert.equal(ui.byId('speech').hidden, false);
  assert.equal(ui.byId('speech-text').textContent, '稍后再看也没有关系。');
});

// jsdom has no layout engine. Supply browser-like geometry, including scroll
// clamping and each row's viewport position, so these assert reading behavior.
function scrollLayout(ui) {
  const main = ui.w.document.querySelector('main'), messages = ui.byId('messages');
  const rows = () => Array.from(messages.children);
  const rowHeight = row => Number(row.dataset.testHeight || 100);
  const contentHeight = () => Math.max(200, rows().reduce((sum, row) => sum + rowHeight(row), 32) + Math.max(0, rows().length - 1) * 12);
  let top = 0;
  Object.defineProperties(main, {
    clientHeight: { configurable: true, get: () => 200 },
    scrollHeight: { configurable: true, get: contentHeight },
    scrollTop: { configurable: true, get: () => Math.min(top, contentHeight() - 200), set: value => { top = Math.max(0, Math.min(value, contentHeight() - 200)); } }
  });
  const originalRect = ui.w.HTMLElement.prototype.getBoundingClientRect;
  ui.w.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this === main) return { top: 100, bottom: 300, height: 200, left: 0, right: 420, width: 420 };
    if (this.classList.contains('message')) {
      const preceding = rows().slice(0, rows().indexOf(this));
      const y = 116 + preceding.reduce((sum, row) => sum + rowHeight(row) + 12, 0) - main.scrollTop;
      return { top: y, bottom: y + rowHeight(this), height: rowHeight(this), left: 0, right: 380, width: 380 };
    }
    return originalRect.call(this);
  };
  return {
    main,
    scrollTo(value) { main.scrollTop = value; main.dispatchEvent(new ui.w.Event('scroll')); },
    reply(id) { ui.emit({ type: 'speak', source: 'chat', request_id: `scroll-${id}`, text: `第 ${id} 条回复` }); },
    fill(count) { for (let i = 0; i < count; i++) this.reply(i); }
  };
}

test('quick chat follows arriving replies only when the reader is close to the latest message', async t => {
  const ui = await screen(t), layout = scrollLayout(ui);
  layout.fill(5);
  layout.scrollTo(layout.main.scrollHeight - layout.main.clientHeight - 20);
  layout.reply(5);
  assert.equal(layout.main.scrollTop, layout.main.scrollHeight - layout.main.clientHeight);
  assert.equal(ui.byId('new-messages').hidden, true);
});

test('new replies preserve an upward reading position and expose an explicit jump to latest', async t => {
  const ui = await screen(t), layout = scrollLayout(ui);
  layout.fill(5); layout.scrollTo(100);
  const anchor = ui.byId('messages').children[1], before = anchor.getBoundingClientRect().top;
  layout.reply(5); layout.reply(6);
  assert.equal(layout.main.scrollTop, 100);
  assert.equal(anchor.getBoundingClientRect().top, before);
  assert.equal(ui.byId('new-messages').hidden, false);
  assert.match(ui.byId('new-messages').textContent, /2 条新消息/);
  ui.byId('new-messages').click();
  assert.equal(layout.main.scrollTop, layout.main.scrollHeight - layout.main.clientHeight);
  assert.equal(ui.byId('new-messages').hidden, true);
});

test('pruning the ninth message compensates for removed height and preserves the visible text position', async t => {
  const ui = await screen(t), layout = scrollLayout(ui);
  layout.fill(8);
  ui.byId('messages').children[0].dataset.testHeight = '140';
  layout.scrollTo(380);
  const anchor = ui.byId('messages').children[3], before = anchor.getBoundingClientRect().top;
  layout.reply(8);
  assert.equal(ui.byId('messages').children.length, 8);
  assert.equal(anchor.isConnected, true);
  assert.equal(anchor.getBoundingClientRect().top, before);
  assert.equal(layout.main.scrollTop, 380 - 140 - 12);
  assert.equal(ui.byId('new-messages').hidden, false);
});

test('scrolling back to the latest message clears the unread hint without a button click', async t => {
  const ui = await screen(t), layout = scrollLayout(ui);
  layout.fill(5); layout.scrollTo(50); layout.reply(5);
  assert.equal(ui.byId('new-messages').hidden, false);
  layout.scrollTo(layout.main.scrollHeight - layout.main.clientHeight);
  assert.equal(ui.byId('new-messages').hidden, true);
});

test('sending a new user message intentionally returns to the latest message and clears unread state', async t => {
  const ui = await screen(t, { chat: async () => ({ reply: '稍后从事件送达' }) }), layout = scrollLayout(ui);
  layout.fill(6); layout.scrollTo(60); layout.reply(6);
  ui.type('我来继续聊'); ui.submit(); await tick();
  assert.equal(layout.main.scrollTop, layout.main.scrollHeight - layout.main.clientHeight);
  assert.equal(ui.byId('new-messages').hidden, true);
  assert.equal(ui.byId('messages').lastElementChild.classList.contains('user'), true);
  assert.equal(ui.byId('messages').lastElementChild.querySelector('.message-copy'), null);
});

test('copying an assistant message sends its complete visible text through the clipboard API once', async t => {
  const copied = [], result = deferred();
  const ui = await screen(t, { copyText: text => { copied.push(text); return result.promise; } });
  const text = '第一段：<strong>这还是纯文本</strong>\n\n第二段，有完整细节。🐾';
  ui.emit({ type: 'speak', source: 'chat', request_id: 'copy-full', text });
  const copy = ui.byId('messages').querySelector('.message-copy');
  ui.type('尚未发送的草稿'); ui.byId('chat-input').focus();
  copy.click(); copy.click();
  assert.deepEqual(copied, [text]); assert.equal(copy.disabled, true);
  result.resolve(true); await tick();
  assert.equal(copy.textContent, '已复制'); assert.equal(copy.disabled, false);
  assert.equal(ui.byId('chat-input').value, '尚未发送的草稿');
  assert.equal(ui.w.document.activeElement, ui.byId('chat-input'));
});

test('copy failure stays beside the reply, permits retry, and does not steal focus or replace chat status', async t => {
  let fail = true;
  const ui = await screen(t, { copyText: async () => { if (fail) throw { message: '剪贴板暂不可用' }; } });
  ui.emit({ type: 'speak', source: 'chat', request_id: 'copy-error', text: '要复制的回复' });
  const copy = ui.byId('messages').querySelector('.message-copy');
  const status = ui.byId('chat-status').textContent;
  copy.focus(); copy.click(); await tick();
  assert.equal(ui.w.document.activeElement, copy);
  assert.equal(copy.textContent, '重试复制'); assert.match(copy.title, /剪贴板暂不可用/);
  assert.equal(ui.byId('chat-status').textContent, status);
  assert.equal(copy.disabled, false);
  fail = false; copy.click(); await tick(); assert.equal(copy.textContent, '已复制');
});
