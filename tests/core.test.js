'use strict';

// Real local HTTP/WebSocket regression tests. Electron and model credentials are unnecessary.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { WebSocketServer } = require('ws');
const { normalizeServer, endpoint, normalizeSettings, sanitizeState, atomicWriteJson, readJson, PetConnection } = require('../src/core');

const initialState = () => ({ mood: 80, satiety: 80, cleanliness: 80, energy: 80, exp: 0, level: 1 });

async function waitFor(predicate, timeout = 2500) {
  const until = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error('Timed out waiting for expected state');
    await delay(10);
  }
}

async function fixture(t, options = {}) {
  const state = options.state || initialState();
  const config = { pet_name: options.petName || '测试桌宠', enable_roam: true, walk_speed: 1.5,
    enable_chatter: true, chatter_lines: ['早安'], sleepy_lines: ['晚安'], chatter_interval_sec: 90, sleepy_threshold: 20 };
  const records = [];
  const sockets = new Set();
  let upgrades = 0;
  let revision = 0;
  const prefix = options.prefix || '';
  const wss = new WebSocketServer({ noServer: true });
  const send = message => {
    for (const socket of sockets) if (socket.readyState === 1) socket.send(JSON.stringify(message));
  };
  const respond = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    records.push({ method: req.method, path: req.url, headers: req.headers, body });
    if (options.token && req.headers['x-pet-token'] !== options.token) return respond(res, 401, { error: 'unauthorized' });
    if (options.onRequest && await options.onRequest({ req, res, body, state, config, send, respond, sockets })) return;
    const route = req.url.slice(prefix.length);
    if (route === '/api/state') return respond(res, 200, { state, revision, pet_name: config.pet_name });
    if (route === '/api/config') {
      if (req.method === 'POST') { Object.assign(config, body); send({ type: 'config', data: config }); }
      return respond(res, 200, config);
    }
    if (route === '/api/chat' || route === '/api/action') {
      state.exp += route === '/api/chat' ? 3 : 5;
      revision++;
      const reply = '测试回复';
      send({ type: 'state', data: state, revision });
      send({ type: 'speak', text: reply, source: body.action || 'chat', request_id: body.request_id });
      return respond(res, 200, { reply, state, revision, request_id: body.request_id });
    }
    if (route === '/api/personas') return respond(res, 200, { personas: [{ id: 'test', name: '测试人格' }] });
    if (route === '/api/generate-lines') return respond(res, 200, { kind: body.kind, lines: ['第一句', '第二句'] });
    return respond(res, 404, { error: 'not found' });
  });
  server.on('upgrade', (req, socket, head) => {
    upgrades++;
    if (req.url !== `${prefix}/ws`) return socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    if (options.token && req.headers['x-pet-token'] !== options.token) return socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (options.sendHello !== false) socket.send(JSON.stringify({ type: 'hello', state, revision,
      pet_name: config.pet_name, config, plugin_version: 'test' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    server.closeAllConnections();
    await Promise.all([new Promise(resolve => wss.close(resolve)), new Promise(resolve => server.close(resolve))]);
  });
  return { url: `http://127.0.0.1:${server.address().port}${prefix}`, state, config, records, sockets, send,
    get upgrades() { return upgrades; } };
}

function connection(t, server, extra = {}) {
  const pet = new PetConnection({ server: server.url, random: () => 0, ...extra });
  t.after(() => pet.stop());
  return pet;
}

test('server normalization preserves reverse proxy prefix and secure websocket scheme', () => {
  assert.equal(normalizeServer('127.0.0.1:9898'), 'http://127.0.0.1:9898');
  assert.equal(normalizeServer(' WSS://example.com/pet/ws/ '), 'https://example.com/pet');
  assert.equal(normalizeServer('https://example.com/pet/api/state'), 'https://example.com/pet');
  assert.equal(endpoint('wss://example.com/pet/ws', '/api/chat'), 'https://example.com/pet/api/chat');
  assert.equal(endpoint('https://example.com/pet/', '/ws', true), 'wss://example.com/pet/ws');
  assert.equal(normalizeServer('[::1]:9898'), 'http://[::1]:9898');
});

test('unsafe or ambiguous server URLs are rejected', () => {
  for (const value of ['', null, 123, 'file:///tmp/pet', 'ftp://example.com',
    'https://user:secret@example.com', 'https://example.com?token=secret', 'https://example.com#token', 'x'.repeat(2100)]) {
    assert.throws(() => normalizeServer(value));
  }
});

test('local settings enforce finite scale and actual booleans', () => {
  for (const input of [null, [], { scale: NaN }, { scale: Infinity }, { scale: 0 }, { scale: 3 },
    { scale: '1' }, { alwaysOnTop: 'false' }, { clickThrough: 1 }, { modelPath: {} }]) {
    assert.throws(() => normalizeSettings(input));
  }
  const settings = normalizeSettings({ server: 'localhost:9898', scale: 0.5, clickThrough: true });
  assert.equal(settings.server, 'http://localhost:9898');
  assert.equal(settings.scale, 0.5);
  assert.equal(settings.clickThrough, true);
});

test('pet state rejects malformed values and bounds visible statistics', () => {
  assert.equal(sanitizeState(null), null);
  assert.equal(sanitizeState({ ...initialState(), energy: NaN }), null);
  assert.equal(sanitizeState({ ...initialState(), level: 0 }), null);
  assert.equal(sanitizeState({ ...initialState(), exp: 1.5 }), null);
  assert.deepEqual(sanitizeState({ ...initialState(), mood: -20, satiety: 200 }), { ...initialState(), mood: 0, satiety: 100 });
});

test('atomic JSON writes replace valid files and corrupted JSON is backed up', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-pet-core-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'settings.json');
  assert.deepEqual(readJson(filename, { scale: 1 }), { scale: 1 });
  atomicWriteJson(filename, { scale: 1 });
  atomicWriteJson(filename, { scale: 2 });
  assert.deepEqual(readJson(filename, {}), { scale: 2 });
  assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')).length, 0);
  fs.writeFileSync(filename, '{"scale":');
  assert.deepEqual(readJson(filename, { scale: 1 }), { scale: 1 });
  const backup = fs.readdirSync(directory).find(name => name.startsWith('settings.json.corrupt-'));
  assert.ok(backup);
  assert.equal(fs.readFileSync(path.join(directory, backup), 'utf8'), '{"scale":');
});

test('failed atomic serialization preserves the previous file', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-pet-core-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'settings.json');
  atomicWriteJson(filename, { saved: true });
  const circular = {}; circular.self = circular;
  assert.throws(() => atomicWriteJson(filename, circular));
  assert.deepEqual(readJson(filename, {}), { saved: true });
  assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')).length, 0);
});

test('real HTTP/WS connection supports auth headers, prefixes and initial synchronization', async t => {
  const server = await fixture(t, { token: 'private-token', prefix: '/pet' });
  const pet = connection(t, server, { token: 'private-token' });
  pet.start();
  await waitFor(() => pet.status.phase === 'online' && server.records.some(r => r.path === '/pet/api/config'));
  assert.equal(pet.petName, '测试桌宠');
  assert.deepEqual(pet.state, server.state);
  assert.equal(pet.config.walk_speed, 1.5);
  await pet.getState();
  assert.equal(server.records.at(-1).headers['x-pet-token'], 'private-token');
  assert.equal(server.records.at(-1).path, '/pet/api/state');
});

test('invalid chat and action inputs never reach the network', async t => {
  const server = await fixture(t);
  const pet = connection(t, server);
  for (const value of ['', ' ', null, 1, {}, 'x'.repeat(4001)]) await assert.rejects(pet.chat(value));
  await assert.rejects(pet.action('erase'));
  await assert.rejects(pet.generateLines('unknown'));
  await assert.rejects(pet.generateLines('chatter', 0));
  assert.equal(server.records.length, 0);
});

test('request timeout aborts transport and never silently resends a mutation', async t => {
  let closed = false;
  const server = await fixture(t, { onRequest: ({ req, res }) => {
    if (req.url !== '/api/chat') return false;
    res.on('close', () => { closed = true; });
    return true;
  } });
  const pet = connection(t, server, { requestTimeout: 40 });
  await assert.rejects(pet.chat('会超时'), /超时/);
  await waitFor(() => closed);
  assert.equal(pet.controllers.size, 0);
  assert.equal(server.records.filter(r => r.path === '/api/chat').length, 1);
});

test('timeout while reading a response body is reported as timeout, not invalid JSON', async t => {
  const server = await fixture(t, { onRequest: ({ req, res }) => {
    if (req.url !== '/api/chat') return false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"reply":');
    return true;
  } });
  const pet = connection(t, server, { requestTimeout: 40 });
  await assert.rejects(pet.chat('未完成的响应'), /超时/);
  assert.equal(pet.controllers.size, 0);
});

test('switching servers cancels old requests and prevents stale state pollution', async t => {
  let pendingResponse;
  const oldServer = await fixture(t, { petName: '旧桌宠', onRequest: ({ req, res }) => {
    if (req.url !== '/api/state') return false;
    pendingResponse = res;
    return true;
  } });
  const newServer = await fixture(t, { petName: '新桌宠', state: { ...initialState(), exp: 25 } });
  const pet = connection(t, oldServer);
  const pending = pet.getState().then(() => null, error => error);
  await waitFor(() => pendingResponse);
  pet.configure(newServer.url);
  await waitFor(() => pet.status.phase === 'online' && pet.petName === '新桌宠');
  pendingResponse.end(JSON.stringify({ state: { ...initialState(), exp: 999 } }));
  assert.ok(await pending instanceof Error);
  await delay(20);
  assert.equal(pet.state.exp, 25);
  assert.equal(pet.controllers.size, 0);
});

test('unexpected disconnect reconnects once and synchronizes again', async t => {
  const server = await fixture(t);
  const pet = connection(t, server);
  pet.start();
  await waitFor(() => pet.status.phase === 'online');
  for (const socket of server.sockets) socket.terminate();
  await waitFor(() => pet.status.phase === 'retrying');
  await waitFor(() => server.upgrades >= 2 && pet.status.phase === 'online');
  assert.equal(server.upgrades, 2);
  assert.equal(pet.attempt, 0);
});

test('authentication failure stops automatic reconnection until settings change', async t => {
  const server = await fixture(t, { token: 'correct' });
  const pet = connection(t, server, { token: 'wrong' });
  pet.start();
  await waitFor(() => pet.status.phase === 'auth_error');
  await delay(900);
  assert.equal(server.upgrades, 1);
  assert.equal(pet.retryTimer, null);
  pet.configure(server.url, 'correct');
  await waitFor(() => pet.status.phase === 'online');
  assert.equal(server.upgrades, 2);
});

test('stop cancels a scheduled reconnect and leaves no live timers', async t => {
  const server = await fixture(t);
  const pet = connection(t, server);
  pet.start();
  await waitFor(() => pet.status.phase === 'online');
  for (const socket of server.sockets) socket.terminate();
  await waitFor(() => pet.status.phase === 'retrying');
  pet.stop();
  await delay(900);
  assert.equal(server.upgrades, 1);
  assert.equal(pet.retryTimer, null);
  assert.equal(pet.heartbeat, null);
  assert.equal(pet.controllers.size, 0);
  assert.equal(pet.status.phase, 'offline');
});

test('state and config broadcasts synchronize two connected desktop cores', async t => {
  const server = await fixture(t);
  const first = connection(t, server);
  const second = connection(t, server);
  first.start(); second.start();
  await waitFor(() => first.status.phase === 'online' && second.status.phase === 'online');
  await first.action('feed');
  await waitFor(() => second.state.exp === 5);
  assert.deepEqual(first.state, second.state);
  await first.saveConfig({ walk_speed: 2.5, pet_name: '小尾巴' });
  await waitFor(() => second.config.walk_speed === 2.5);
  assert.equal(second.petName, '小尾巴');
});

test('duplicate WebSocket speak request IDs emit one speech bubble', async t => {
  const server = await fixture(t);
  const pet = connection(t, server);
  const spoken = [];
  pet.on('update', update => { if (update.type === 'speak') spoken.push(update); });
  pet.start();
  await waitFor(() => pet.status.phase === 'online');
  server.send({ type: 'speak', text: '只说一次', request_id: 'same-reply', source: 'chat' });
  server.send({ type: 'speak', text: '只说一次', request_id: 'same-reply', source: 'chat' });
  await waitFor(() => spoken.length > 0);
  await delay(30);
  assert.equal(spoken.length, 1);
});

test('chat and actions attach unique request IDs and emit one response each', async t => {
  const server = await fixture(t);
  const pet = connection(t, server);
  const spoken = [];
  pet.on('update', update => { if (update.type === 'speak') spoken.push(update); });
  pet.start();
  await waitFor(() => pet.status.phase === 'online');
  await pet.chat('你好');
  await pet.action('feed');
  await delay(30);
  const records = server.records.filter(r => r.method === 'POST');
  assert.equal(records.length, 2);
  assert.equal(typeof records[0].body.request_id, 'string');
  assert.ok(records[0].body.request_id.length > 0);
  assert.notEqual(records[0].body.request_id, records[1].body.request_id);
  assert.equal(spoken.length, 2);
});

test('late HTTP state cannot overwrite a newer WebSocket revision', async t => {
  let reply;
  const server = await fixture(t, { onRequest: ({ req, res, respond }) => {
    if (req.url !== '/api/state') return false;
    reply = () => respond(res, 200, { state: { ...initialState(), exp: 3 }, revision: 1 });
    return true;
  } });
  const pet = connection(t, server);
  pet.start();
  await waitFor(() => pet.status.phase === 'online');
  const pending = pet.getState();
  await waitFor(() => reply);
  server.send({ type: 'state', data: { ...initialState(), exp: 9 }, revision: 2 });
  await waitFor(() => pet.state.exp === 9);
  reply();
  await pending;
  assert.equal(pet.state.exp, 9);
});

test('reconnect accepts a reset server revision and ignores HTTP from the previous connection', async t => {
  let reply;
  const server = await fixture(t, { onRequest: ({ req, res, respond }) => {
    if (req.url !== '/api/state') return false;
    reply = () => respond(res, 200, { state: { ...initialState(), exp: 99 }, revision: 51 });
    return true;
  } });
  const pet = connection(t, server);
  pet.start();
  await waitFor(() => pet.status.phase === 'online');
  server.send({ type: 'state', data: { ...initialState(), exp: 50 }, revision: 50 });
  await waitFor(() => pet.state.exp === 50);
  const pending = pet.getState();
  await waitFor(() => reply);
  for (const socket of server.sockets) socket.terminate();
  await waitFor(() => server.upgrades >= 2 && pet.status.phase === 'online');
  assert.equal(pet.state.exp, 0);
  reply();
  await pending;
  assert.equal(pet.state.exp, 0);
  server.send({ type: 'state', data: { ...initialState(), exp: 1 }, revision: 1 });
  await waitFor(() => pet.state.exp === 1);
});

test('slow initial HTTP config cannot overwrite a newer WS config update', async t => {
  let reply;
  const server = await fixture(t, { onRequest: ({ req, res, respond }) => {
    if (req.url !== '/api/config') return false;
    reply = () => respond(res, 200, { pet_name: '旧配置', walk_speed: 1 });
    return true;
  } });
  const pet = connection(t, server);
  pet.start();
  await waitFor(() => reply && pet.status.phase === 'online');
  server.send({ type: 'config', data: { pet_name: '新配置', walk_speed: 3 } });
  await waitFor(() => pet.petName === '新配置');
  reply();
  await waitFor(() => pet.controllers.size === 0);
  assert.equal(pet.petName, '新配置');
  assert.equal(pet.config.walk_speed, 3);
});

test('slow config-save response cannot overwrite a subsequent config broadcast', async t => {
  let reply;
  const server = await fixture(t, { onRequest: ({ req, res, respond }) => {
    if (req.url !== '/api/config' || req.method !== 'POST') return false;
    reply = () => respond(res, 200, { pet_name: '本地旧保存', walk_speed: 1 });
    return true;
  } });
  const pet = connection(t, server);
  pet.start();
  await waitFor(() => pet.status.phase === 'online' && pet.controllers.size === 0);
  const save = pet.saveConfig({ pet_name: '本地旧保存', walk_speed: 1 });
  await waitFor(() => reply);
  server.send({ type: 'config', data: { pet_name: '另一台的新保存', walk_speed: 4 } });
  await waitFor(() => pet.config.walk_speed === 4);
  reply();
  await save;
  assert.equal(pet.petName, '另一台的新保存');
  assert.equal(pet.config.walk_speed, 4);
});

test('persona synchronization preserves the plugin supported 20000 characters', async t => {
  const server = await fixture(t);
  const pet = connection(t, server);
  pet.mergeConfig({ persona: '人'.repeat(20000) });
  assert.equal(pet.config.persona.length, 20000);
});

test('config synchronization ignores malformed types and preserves usable defaults', async t => {
  const server = await fixture(t);
  const pet = connection(t, server);
  pet.mergeConfig({ enable_roam: 'false', walk_speed: NaN, chatter_lines: [{}], sleepy_threshold: 0 });
  assert.equal(pet.config.enable_roam, true);
  assert.equal(pet.config.walk_speed, 1.5);
  assert.deepEqual(pet.config.chatter_lines, ['忙完了就陪我玩一会儿吧。', '我在这里陪你。']);
  assert.equal(pet.config.sleepy_threshold, 0);
});

test('malformed WS messages do not crash synchronization', async t => {
  const server = await fixture(t);
  const pet = connection(t, server);
  pet.start();
  await waitFor(() => pet.status.phase === 'online');
  for (const socket of server.sockets) for (const value of ['{', 'null', '[]', 'true', '"text"']) socket.send(value);
  server.send({ type: 'state', data: { mood: 'invalid' } });
  server.send({ type: 'state', data: { ...initialState(), exp: 10 }, revision: 1 });
  await waitFor(() => pet.state.exp === 10);
  assert.equal(pet.status.phase, 'online');
});
