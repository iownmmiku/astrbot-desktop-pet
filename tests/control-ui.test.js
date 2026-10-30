'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { JSDOM } = require('jsdom');
const { version: appVersion } = require('../package.json');
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
    snapshot: async () => ({ settings: { server: 'http://127.0.0.1:9898', scale: 1, alwaysOnTop: true }, status: { phase: 'online' }, state: null, config: {}, appVersion }),
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

test('connection check uses the unsaved draft and renders each diagnostic independently', async t => {
  const calls = [];
  const ui = await screen(t, {
    getState: () => assert.fail('must not test the active connection'),
    saveSettings: () => assert.fail('testing must not save settings'),
    testConnection: async draft => {
      calls.push(JSON.parse(JSON.stringify(draft)));
      return { http: { ok: true, status: 200 }, auth: { ok: false, message: '令牌不匹配' }, websocket: { ok: false, message: '握手失败' } };
    }
  });
  ui.emit({ type: 'settings', data: { server: 'http://127.0.0.1:9898', tokenConfigured: true } });
  ui.byId('server').value = 'https://new.example.com/pet';
  ui.byId('server').dispatchEvent(new ui.w.Event('input', { bubbles: true }));
  assert.match(ui.byId('connection-token-hint').textContent, /测试与保存均不沿用原服务器令牌/);
  assert.match(ui.byId('connection-token-hint').textContent, /保存后会清除旧令牌/);
  ui.byId('test-connection').click(); await tick();
  assert.deepEqual(calls, [{ server: 'https://new.example.com/pet', token: '', clearToken: false }]);
  assert.equal(ui.byId('test-http').dataset.result, 'success');
  assert.equal(ui.byId('test-auth').dataset.result, 'error');
  assert.match(ui.byId('test-auth').textContent, /令牌不匹配/);
  assert.equal(ui.byId('test-websocket').dataset.result, 'error');
  assert.equal(ui.byId('server').value, 'https://new.example.com/pet');
});

test('a diagnostic for a previous draft never labels an edited address as tested', async t => {
  let finish;
  const ui = await screen(t, { testConnection: () => new Promise(resolve => { finish = resolve; }) });
  ui.byId('test-connection').click();
  assert.equal(ui.byId('test-connection').disabled, true);
  ui.byId('server').value = 'https://second.example.com';
  ui.byId('server').dispatchEvent(new ui.w.Event('input', { bubbles: true }));
  finish({ http: { ok: true }, auth: { ok: true }, websocket: { ok: true } }); await tick();
  assert.match(ui.byId('connection-test-summary').textContent, /请重新测试/);
  assert.equal(ui.byId('test-http').dataset.result, 'unknown');
  assert.equal(ui.byId('test-connection').disabled, false);
});

test('connection failures preserve unknown authentication and permit another check', async t => {
  let fail = false;
  const ui = await screen(t, { testConnection: async () => {
    if (fail) throw new Error('地址格式不正确');
    return { http: { ok: false, message: '服务不可达' }, auth: { ok: null, message: '无法判断令牌' }, websocket: { ok: false } };
  } });
  ui.byId('test-connection').click(); await tick();
  assert.equal(ui.byId('test-auth').dataset.result, 'unknown');
  assert.match(ui.byId('test-auth').textContent, /无法判断/);
  fail = true; ui.byId('test-connection').click(); await tick();
  assert.match(ui.byId('connection-test-summary').textContent, /地址格式/);
  assert.equal(ui.byId('test-connection').disabled, false);
  assert.equal(ui.byId('test-http').dataset.result, 'unknown');
});

test('incoming messages preserve the reading position and offer a jump to new messages', async t => {
  const ui = await screen(t);
  const list = ui.byId('messages');
  let height = 1000;
  Object.defineProperties(list, { scrollHeight: { get: () => height }, clientHeight: { get: () => 200 } });
  list.scrollTop = 120;
  ui.emit({ type: 'speak', text: '第一条新消息' }); height = 1080;
  ui.emit({ type: 'speak', text: '第二条新消息' }); height = 1160;
  assert.equal(list.scrollTop, 120);
  assert.equal(ui.byId('new-messages').hidden, false);
  assert.match(ui.byId('new-messages').textContent, /2 条新消息/);
  ui.byId('new-messages').click();
  assert.equal(list.scrollTop, height);
  assert.equal(ui.byId('new-messages').hidden, true);
  list.scrollTop = height - 200;
  ui.emit({ type: 'speak', text: '继续阅读最新消息' });
  assert.equal(list.scrollTop, height);
  assert.equal(ui.byId('new-messages').hidden, true);
});

test('scrolling to the bottom or clearing the view dismisses unread indicators', async t => {
  const ui = await screen(t), list = ui.byId('messages');
  Object.defineProperties(list, { scrollHeight: { get: () => 800 }, clientHeight: { get: () => 200 } });
  list.scrollTop = 0; ui.emit({ type: 'speak', text: '新消息' });
  list.scrollTop = 600; list.dispatchEvent(new ui.w.Event('scroll'));
  assert.equal(ui.byId('new-messages').hidden, true);
  list.scrollTop = 0; ui.emit({ type: 'speak', text: '又一条' });
  ui.byId('clear-chat').click();
  assert.equal(ui.byId('new-messages').hidden, true);
  assert.equal(list.children.length, 0);
});

test('a delayed chat result never steals focus from another page or control', async t => {
  let finish;
  const ui = await screen(t, { chat: () => new Promise(resolve => { finish = resolve; }) });
  ui.w.document.querySelector('[data-view=chat]').click();
  ui.byId('chat-input').value = '慢慢想'; ui.submit('chat-form');
  ui.w.document.querySelector('[data-view=connection]').click(); ui.byId('server').focus();
  finish({ reply: '好' }); await tick();
  assert.equal(ui.w.document.activeElement, ui.byId('server'));
  ui.w.document.querySelector('[data-view=chat]').click();
  ui.byId('chat-input').value = '第二次'; ui.submit('chat-form'); ui.byId('clear-chat').focus();
  finish({ reply: '好' }); await tick();
  assert.equal(ui.w.document.activeElement, ui.byId('clear-chat'));
});

test('message copying sends only the rendered text through the clipboard bridge', async t => {
  const copied = [];
  const ui = await screen(t, { copyText: async text => { copied.push(text); } });
  const text = '<script>danger()</script>\n完整消息';
  ui.emit({ type: 'speak', text });
  const copy = ui.w.document.querySelector('.message-copy'); copy.click(); await tick();
  assert.deepEqual(copied, [text]);
  assert.equal(copy.textContent, '已复制');
  assert.equal(ui.w.document.querySelector('.message-body script'), null);
});

test('interaction buttons show pending state and apply server cooldowns without clock skew', async t => {
  let finish;
  const ui = await screen(t, { action: () => new Promise(resolve => { finish = resolve; }) });
  const feed = ui.w.document.querySelector('[data-action=feed]'); feed.click();
  assert.equal(feed.disabled, true); assert.equal(feed.getAttribute('aria-busy'), 'true');
  assert.match(feed.textContent, /处理中/);
  const now = Date.now();
  finish({ interactions: { server_time: now / 1000 + 60000, received_at_ms: now - 3000, cooldowns: { feed: 8 } } }); await tick();
  assert.equal(feed.getAttribute('aria-busy'), 'false');
  assert.match(feed.textContent, /5 秒后可用/); assert.equal(feed.disabled, true);
  assert.match(ui.byId('action-status').textContent, /已完成/);
  ui.emit({ type: 'interactions', data: { received_at_ms: now - 4000, cooldowns: { feed: 0 } } });
  assert.equal(feed.disabled, true, 'a late snapshot must not reset a newer cooldown');
  ui.emit({ type: 'interactions', data: { received_at_ms: now + 1, cooldowns: {} } });
  assert.equal(feed.disabled, false);
});

test('cooldown errors disable only the attempted action and count down to an enabled button', async t => {
  const ui = await screen(t, { action: async () => { throw { message: '请给小伙伴一点时间', retry_after_sec: 0.05 }; } });
  const poke = ui.w.document.querySelector('[data-action=poke]'); poke.click(); await tick();
  assert.equal(poke.disabled, true); assert.match(poke.textContent, /1 秒后可用/);
  assert.equal(ui.w.document.querySelector('[data-action=feed]').disabled, false);
  assert.match(ui.byId('action-status').textContent, /请给小伙伴一点时间/);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(poke.disabled, false); assert.equal(poke.querySelector('.action-feedback').textContent, '');
});

test('sleep and wake use separate cooldowns while retaining pending feedback on the same button', async t => {
  let finish;
  const ui = await screen(t, { action: () => new Promise(resolve => { finish = resolve; }) });
  const state = { mood: 80, satiety: 80, cleanliness: 80, energy: 20, level: 1, exp: 0, is_sleeping: true };
  const button = ui.byId('sleep-action'); button.click();
  ui.emit({ type: 'state', data: state });
  assert.equal(button.dataset.action, 'wake'); assert.equal(button.disabled, true);
  finish({ interactions: { cooldowns: { sleep: 10, wake: 0 } } }); await tick();
  assert.equal(button.disabled, false);
  ui.emit({ type: 'interactions', data: { cooldowns: { sleep: 10, wake: 6 } } });
  assert.match(button.textContent, /6 秒后可用/); assert.equal(button.disabled, true);
});

test('switching servers clears interaction cooldowns and ignores old pending action completion', async t => {
  let finish;
  const ui = await screen(t, { action: () => new Promise(resolve => { finish = resolve; }) });
  const button = ui.w.document.querySelector('[data-action=feed]'); button.click();
  ui.emit({ type: 'connection_changed' });
  finish({ interactions: { cooldowns: { feed: 10 } } }); await tick();
  assert.equal(button.disabled, false);
  assert.match(ui.byId('action-status').textContent, /等待互动状态同步/);
});

test('startup preferences save only editable settings and runtime broadcasts preserve unsaved choices', async t => {
  const saves = [];
  const ui = await screen(t, { saveSettings: async value => { saves.push(JSON.parse(JSON.stringify(value))); return value; } });
  ui.emit({ type: 'settings', data: { launchAtLogin: false, startMinimized: false, quietOnFullscreen: true, startup: { supported: true, enabled: false, message: '已关闭系统登录项' }, fullscreen: { supported: true, active: false, message: '没有全屏窗口' } } });
  ui.byId('launch-at-login').checked = true; ui.byId('start-minimized').checked = true; ui.byId('quiet-on-fullscreen').checked = false;
  ui.byId('startup-form').dispatchEvent(new ui.w.Event('input', { bubbles: true }));
  ui.emit({ type: 'settings', data: { fullscreen: { supported: true, active: true, message: '全屏应用中' } } });
  assert.equal(ui.byId('launch-at-login').checked, true);
  assert.match(ui.byId('fullscreen-status').textContent, /全屏应用中/);
  ui.submit('startup-form'); await tick();
  assert.deepEqual(saves[0], { launchAtLogin: true, startMinimized: true, quietOnFullscreen: false });
  ui.emit({ type: 'settings', data: { startup: { supported: false, enabled: false, message: '便携环境不支持' } } });
  assert.equal(ui.byId('launch-at-login').disabled, true);
  ui.submit('startup-form'); await tick();
  assert.equal(Object.hasOwn(saves[1], 'launchAtLogin'), false);
  assert.match(ui.byId('startup-status').textContent, /便携环境不支持/);
});

test('update checks are manual and desktop success remains visible when the plugin check fails', async t => {
  let checks = 0; const opened = [];
  const ui = await screen(t, {
    checkUpdates: async () => { checks++; return { checkedAt: '2026-10-30T10:00:00Z', desktop: { current: '0.8.0', latest: '0.8.1', available: true, notes: '<img src=x> 更新说明' }, plugin: { current: '0.5.0', error: '网络超时' } }; },
    openRelease: async kind => { opened.push(kind); }
  });
  ui.w.document.querySelector('[data-view=system]').click(); await tick();
  assert.equal(checks, 0);
  ui.byId('check-updates').click(); await tick();
  assert.equal(checks, 1);
  assert.equal(ui.byId('desktop-version-latest').textContent, '0.8.1');
  assert.match(ui.byId('desktop-update-status').textContent, /有新版本/);
  assert.match(ui.byId('plugin-update-status').textContent, /网络超时/);
  assert.equal(ui.byId('desktop-update-notes').querySelector('img'), null);
  assert.equal(ui.byId('desktop-update-notes').hidden, false);
  ui.w.document.querySelector('[data-release=plugin]').click(); await tick();
  assert.deepEqual(opened, ['plugin']);
});

test('request recovery applies the current outer cooldown snapshot, never the historical cached result', async t => {
  const ui = await screen(t, {
    chat: async (_text, id) => { throw { message: '连接超时', request_id: id }; },
    requestStatus: async () => ({
      status: 'completed',
      interactions: { received_at_ms: Date.now(), cooldowns: { feed: 0, poke: 4 } },
      result: { interactions: { cooldowns: { feed: 100, poke: 0 } }, reply: '缓存的原回复' }
    })
  });
  ui.byId('chat-input').value = '继续原请求'; ui.submit('chat-form'); await tick();
  ui.byId('check-chat').click(); await tick();
  assert.equal(ui.byId('chat-recovery').hidden, true);
  assert.equal(ui.w.document.querySelector('[data-action=feed]').disabled, false);
  assert.equal(ui.w.document.querySelector('[data-action=poke]').disabled, true);
  assert.match(ui.w.document.querySelector('[data-action=poke]').textContent, /4 秒后可用/);
});

test('an unrecognized installed version is never described as current and preserves the server guidance', async t => {
  let current = '未知';
  const ui = await screen(t, { checkUpdates: async () => ({
    checkedAt: Date.now(), desktop: { current: '0.8.0', latest: '0.8.0', available: false },
    plugin: { current, latest: '0.5.0', available: false, message: '连接后可再次检查。' },
    compatibility: { minimumPlugin: '0.5.0', ok: null }
  }) });
  for (const version of ['未知', '0.5', '999999999999999999999.5.0']) {
    current = version; ui.byId('check-updates').click(); await tick();
    assert.match(ui.byId('plugin-update-status').textContent, /安装版本未知/);
    assert.match(ui.byId('plugin-update-status').textContent, /连接后可再次检查/);
    assert.doesNotMatch(ui.byId('plugin-update-status').textContent, /已是最新/);
    assert.match(ui.byId('update-compatibility').textContent, /版本未知.*最低要求 0.5.0/);
  }
});

test('compatibility reports the minimum plugin requirement without promising future-version compatibility', async t => {
  let compatible = false;
  const ui = await screen(t, { checkUpdates: async () => ({
    checkedAt: Date.now(), desktop: { current: '0.8.0', latest: '0.8.0', available: false },
    plugin: { current: compatible ? '0.5.0' : '0.4.0', latest: '0.5.0', available: !compatible },
    compatibility: { minimumPlugin: '0.5.0', ok: compatible }
  }) });
  ui.byId('check-updates').click(); await tick();
  const summary = ui.byId('update-compatibility');
  assert.equal(summary.hidden, false); assert.equal(summary.classList.contains('error'), true);
  assert.match(summary.textContent, /低于最低要求 0.5.0.*升级插件/);
  compatible = true; ui.byId('check-updates').click(); await tick();
  assert.equal(summary.classList.contains('error'), false);
  assert.match(summary.textContent, /已满足最低插件版本 0.5.0/);
  assert.match(summary.textContent, /不保证所有未来版本兼容/);
});
