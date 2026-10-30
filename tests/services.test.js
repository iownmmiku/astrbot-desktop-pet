'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const { WebSocketServer } = require('ws');
const { diagnosticTarget, boundedJson, testConnection } = require('../src/diagnostics');
const { UpdateChecker, releaseUrl, isNewer } = require('../src/updates');
const { StartupController, loginTarget } = require('../src/startup');
const { FullscreenMonitor, quickChatBounds } = require('../src/fullscreen');

const state = { mood: 80, satiety: 80, cleanliness: 80, energy: 80, exp: 0, level: 1 };
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
async function waitFor(predicate, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) assert.fail('Expected state was not reached'); await delay(10); }
}

async function serverFixture(t, { prefix = '/pet', token = '', onRequest, hello = { type: 'hello', state } } = {}) {
  const requests = [], sockets = new Set(); let websocketClosed = 0;
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, method: req.method, token: req.headers['x-pet-token'] });
    if (onRequest?.(req, res)) return;
    const denied = token && req.headers['x-pet-token'] !== token;
    res.writeHead(denied ? 401 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(denied ? { error: 'unauthorized' } : { state, plugin_version: '0.5.0' }));
  });
  server.on('upgrade', (req, socket, head) => {
    requests.push({ path: req.url, method: 'UPGRADE', token: req.headers['x-pet-token'] });
    if (req.url !== `${prefix}/ws` || (token && req.headers['x-pet-token'] !== token)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', socket => {
    sockets.add(socket); socket.on('error', () => {});
    socket.on('close', () => { websocketClosed++; sockets.delete(socket); });
    if (hello !== null) socket.send(JSON.stringify(hello));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    server.closeAllConnections();
    await Promise.all([new Promise(resolve => wss.close(resolve)), new Promise(resolve => server.close(resolve))]);
  });
  return { url: `http://127.0.0.1:${server.address().port}${prefix}`, requests, sockets, get websocketClosed() { return websocketClosed; } };
}

test('draft diagnostics reuse saved token only for the same normalized endpoint and never mutate settings', () => {
  const saved = Object.freeze({ server: 'https://example.test/pet', token: 'saved-fixture-token' });
  const draft = Object.freeze({ server: 'wss://example.test/pet/ws', token: '' });
  assert.deepEqual(diagnosticTarget(draft, saved), { server: saved.server, token: saved.token, tokenReused: true });
  assert.equal(diagnosticTarget({ server: 'https://elsewhere.test', token: '' }, saved).token, '');
  assert.equal(diagnosticTarget({ server: 'https://example.test/different', token: '' }, saved).token, '');
  assert.equal(diagnosticTarget({ ...draft, clearToken: true }, saved).token, '');
  assert.equal(diagnosticTarget({ ...draft, token: ' replacement ' }, saved).token, 'replacement');
  assert.equal(saved.token, 'saved-fixture-token'); assert.equal(draft.token, '');
});

test('diagnostic inputs reject ambiguous credentials and unavailable saved tokens', () => {
  assert.throws(() => diagnosticTarget({ server: 'https://user:password@example.test' }));
  assert.throws(() => diagnosticTarget({ server: 'https://example.test?token=secret' }));
  assert.throws(() => diagnosticTarget({ server: 'https://example.test', token: 12 }));
  assert.throws(() => diagnosticTarget({ server: 'https://example.test', clearToken: 'false' }));
  assert.throws(() => diagnosticTarget({ server: 'https://example.test' }, { server: 'https://example.test', tokenUnavailable: true }), /重新输入/);
});

test('real HTTP and WebSocket diagnostics preserve prefix, use only headers, and close the temporary socket', async t => {
  const fixture = await serverFixture(t, { token: 'only-a-test-token' });
  const saved = Object.freeze({ server: fixture.url, token: 'only-a-test-token' });
  const result = await testConnection({ server: fixture.url }, saved, { timeout: 700 });
  assert.equal(result.ok, true); assert.equal(result.tokenReused, true);
  assert.equal(result.http.version, '0.5.0'); assert.equal(result.websocket.status, 101);
  assert.deepEqual(fixture.requests.map(row => row.path).sort(), ['/pet/api/state', '/pet/ws']);
  assert.ok(fixture.requests.every(row => row.token === saved.token));
  assert.ok(fixture.requests.every(row => ['GET', 'UPGRADE'].includes(row.method)));
  assert.equal(JSON.stringify(result).includes(saved.token), false);
  await waitFor(() => fixture.websocketClosed === 1);
});

test('wrong credentials are reported as authentication failures without echoing the supplied token', async t => {
  const fixture = await serverFixture(t, { token: 'correct-test-token' });
  const result = await testConnection({ server: fixture.url, token: 'incorrect-test-token' }, {}, { timeout: 700 });
  assert.equal(result.ok, false); assert.equal(result.auth.ok, false);
  assert.equal(result.http.status, 401); assert.equal(result.websocket.status, 401);
  assert.equal(JSON.stringify(result).includes('incorrect-test-token'), false);
});

test('diagnostic versions cannot echo arbitrary server text or the supplied token', async t => {
  const fixture = await serverFixture(t, { onRequest: (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state, plugin_version: req.headers['x-pet-token'] })); return true;
  } });
  const result = await testConnection({ server: fixture.url, token: 'private-fixture-not-a-version' }, {}, { timeout: 700 });
  assert.equal(result.ok, true); assert.equal(result.http.version, '未知');
  assert.equal(JSON.stringify(result).includes('private-fixture-not-a-version'), false);
});

test('missing WebSocket hello times out and terminates the diagnostic connection', async t => {
  const fixture = await serverFixture(t, { hello: null });
  const result = await testConnection({ server: fixture.url }, {}, { timeout: 90 });
  assert.equal(result.http.ok, true); assert.equal(result.websocket.ok, false);
  assert.match(result.websocket.message, /超时/);
  await waitFor(() => fixture.websocketClosed === 1);
});

test('HTTP timeout aborts the in-flight stream while WebSocket success remains separately visible', async t => {
  let closed = false;
  const fixture = await serverFixture(t, { onRequest: (_req, res) => { res.on('close', () => { closed = true; }); return true; } });
  const result = await testConnection({ server: fixture.url }, {}, { timeout: 90 });
  assert.equal(result.http.ok, false); assert.match(result.http.message, /超时/);
  assert.equal(result.websocket.ok, true); await waitFor(() => closed);
});

test('rejected HTTP diagnostics release an unfinished response rather than leaking a connection', async t => {
  let closed = false;
  const fixture = await serverFixture(t, { onRequest: (_req, res) => {
    res.on('close', () => { closed = true; }); res.writeHead(401, { 'Content-Type': 'application/json' }); res.write('{"error":"'); return true;
  } });
  const result = await testConnection({ server: fixture.url, token: 'test-only' }, {}, { timeout: 100 });
  assert.equal(result.http.status, 401);
  await waitFor(() => closed, 500);
});

test('a too-large declared response body is cancelled before reading', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const response = new Response(body, { headers: { 'content-length': '500000' } });
  await assert.rejects(boundedJson(response, 100), /large/);
  assert.equal(cancelled, true);
});

test('a chunked body exceeding the limit is cancelled instead of parsed', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(200)); }, cancel() { cancelled = true; } });
  await assert.rejects(boundedJson(new Response(body), 100), /large/);
  assert.equal(cancelled, true);
});

test('diagnostics do not follow HTTP redirects or accept an unrelated state payload', async t => {
  let redirected = false;
  const fixture = await serverFixture(t, { hello: { type: 'hello', state: {} }, onRequest: (req, res) => {
    if (req.url === '/redirected') redirected = true;
    res.writeHead(302, { location: '/redirected' }); res.end(); return true;
  } });
  const result = await testConnection({ server: fixture.url }, {}, { timeout: 80 });
  assert.equal(result.ok, false); assert.equal(result.http.ok, false); assert.equal(result.websocket.ok, false);
  assert.equal(redirected, false);
});

function release(kind, version = '0.9.0', extra = {}) {
  const repo = kind === 'desktop' ? 'astrbot-desktop-pet' : 'astrbot_plugin_desktop_pet';
  return { draft: false, prerelease: false, tag_name: `v${version}`, html_url: `https://github.com/iownmmiku/${repo}/releases/tag/v${version}`, body: '更新说明', ...extra };
}

test('updates use public project endpoints, coalesce parallel checks, and compare versions numerically', async () => {
  const calls = []; let unblock;
  const wait = new Promise(resolve => { unblock = resolve; });
  const checker = new UpdateChecker({ now: () => 12345, fetchImpl: async (url, options) => {
    calls.push({ url, options }); await wait;
    return jsonResponse(release(url.includes('astrbot-desktop-pet/') ? 'desktop' : 'plugin', '0.10.0'));
  } });
  const a = checker.check({ desktop: '0.8.0', plugin: '0.5.0' }); const b = checker.check({ desktop: '0.8.0', plugin: '0.5.0' });
  assert.equal(a, b); assert.equal(calls.length, 2); unblock();
  const result = await a;
  assert.equal(result.checkedAt, 12345); assert.equal(result.desktop.available, true); assert.equal(result.compatibility.ok, true);
  assert.ok(calls.every(call => call.url.startsWith('https://api.github.com/repos/iownmmiku/')));
  assert.ok(calls.every(call => !Object.keys(call.options.headers).some(key => /token|authorization/i.test(key))));
  assert.equal(isNewer('v0.10.0', '0.9.0'), true); assert.equal(isNewer('nonsense', '0.9.0'), false);
});

test('release links cannot leave the two fixed project release pages', () => {
  assert.equal(releaseUrl('desktop'), 'https://github.com/iownmmiku/astrbot-desktop-pet/releases/latest');
  for (const candidate of [
    'https://evil.test/redirect', 'javascript:alert(1)',
    'https://github.com/other/project/releases/tag/v1.0.0',
    'https://github.com/iownmmiku/astrbot-desktop-pet/releases/tag/v1.0.0?redirect=evil',
    'https://someone@github.com/iownmmiku/astrbot-desktop-pet/releases/tag/v1.0.0'
  ]) assert.throws(() => releaseUrl('desktop', candidate));
  assert.throws(() => releaseUrl('__proto__'));
});

test('draft, prerelease and invalid-host update responses cannot become available releases', async () => {
  for (const extra of [{ draft: true }, { prerelease: true }, { html_url: 'https://evil.test' }, { tag_name: 'latest' }]) {
    const checker = new UpdateChecker({ fetchImpl: async url => jsonResponse(release(url.includes('astrbot-desktop-pet/') ? 'desktop' : 'plugin', '9.0.0', extra)) });
    const result = await checker.check({ desktop: '0.8.0', plugin: '0.5.0' });
    assert.equal(result.desktop.available, false); assert.ok(result.desktop.error);
    assert.equal(result.plugin.available, false); assert.ok(result.plugin.error);
  }
});

test('update timeout and rate limits provide safe errors and abort the request', async () => {
  let aborted = 0;
  const timeoutChecker = new UpdateChecker({ timeout: 25, fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { aborted++; reject(new DOMException('test endpoint secret', 'AbortError')); }, { once: true });
  }) });
  const result = await timeoutChecker.check({ desktop: '0.8.0', plugin: '0.5.0' });
  assert.equal(aborted, 2); assert.match(result.desktop.error, /超时/); assert.equal(JSON.stringify(result).includes('secret'), false);
  let limitSignal;
  const limited = new UpdateChecker({ fetchImpl: async (_url, options) => { limitSignal = options.signal; return jsonResponse({}, 429); } });
  const limits = await limited.check({ desktop: '0.8.0', plugin: '0.5.0' });
  assert.match(limits.desktop.error, /限额/); assert.equal(limitSignal.aborted, true, 'unfinished non-OK responses need cancellation');
});

test('portable login startup targets the original EXE, preserves spaces, and launches in the background', () => {
  const target = loginTarget({ platform: 'win32', isPackaged: true, isolated: false, executable: 'C:\\Temp\\unpacked\\app.exe', portableExecutable: 'D:\\My Pets\\AstrBot.exe' });
  assert.equal(target.path, 'D:\\My Pets\\AstrBot.exe'); assert.deepEqual(target.args, ['--background']);
  assert.equal(loginTarget({ platform: 'win32', isPackaged: false, isolated: false }).supported, false);
  assert.equal(loginTarget({ platform: 'win32', isPackaged: true, isolated: true }).supported, false);
  assert.equal(loginTarget({ platform: 'linux', isPackaged: true, isolated: false }).supported, false);
});

test('startup controller writes only through its injected app and verifies the effective setting', () => {
  const writes = []; let enabled = false;
  const app = { isPackaged: true, getLoginItemSettings: () => ({ openAtLogin: enabled, executableWillLaunchAtLogin: enabled }), setLoginItemSettings: options => { writes.push(options); enabled = options.openAtLogin; } };
  const startup = new StartupController(app, { platform: 'win32', isolated: false, portableExecutable: 'D:\\Pet.exe' });
  startup.setEnabled(true); assert.equal(startup.status().enabled, true);
  startup.setEnabled(false); assert.equal(startup.status().enabled, false);
  assert.deepEqual(writes.map(item => item.openAtLogin), [true, false]);
  assert.ok(writes.every(item => item.path === 'D:\\Pet.exe' && item.args[0] === '--background'));
  assert.throws(() => startup.setEnabled('true'));
  app.setLoginItemSettings = () => {};
  assert.throws(() => startup.setEnabled(true), /没有应用/);
});

test('unsupported startup environments never touch login items', () => {
  let touched = false;
  const app = { isPackaged: false, getLoginItemSettings() { touched = true; }, setLoginItemSettings() { touched = true; } };
  const startup = new StartupController(app, { platform: 'win32', isolated: false });
  assert.equal(startup.status().supported, false); startup.setEnabled(false); assert.throws(() => startup.setEnabled(true));
  assert.equal(touched, false);
});

function workerFixture(t, extra = {}) {
  const children = [], changes = [], launches = [];
  const monitor = new FullscreenMonitor({ platform: 'win32', parentPid: 3456, watchdogMs: 1000, onChange: value => changes.push(value), spawnImpl: (exe, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = 0;
    child.kill = () => { child.killed++; child.stdout.end(); child.stderr.end(); child.emit('exit', 0); return true; };
    children.push(child); launches.push({ exe, args, options }); return child;
  }, ...extra });
  t.after(() => monitor.stop());
  return { monitor, changes, children, launches };
}

test('fullscreen helper starts once, stays hidden, parses partial records, and closes on stop', t => {
  const { monitor, children, launches } = workerFixture(t);
  monitor.start(); monitor.start(); assert.equal(children.length, 1);
  assert.equal(launches[0].options.windowsHide, true);
  const decoded = Buffer.from(launches[0].args.at(-1), 'base64').toString('utf16le');
  assert.ok(decoded.includes('$OwnerProcessId = 3456')); assert.equal(decoded.includes('__PARENT_PID__'), false);
  children[0].stdout.write('{"active":'); assert.equal(monitor.status().active, false);
  children[0].stdout.write('true}\n'); assert.equal(monitor.status().active, true);
  monitor.stop(); assert.equal(children[0].killed, 1); assert.equal(monitor.status().active, false);
});

test('foreground quick chat keeps the previous fullscreen state instead of revealing the pet', t => {
  const { monitor, children } = workerFixture(t);
  monitor.start(); children[0].stdout.write('{"active":true}\n');
  children[0].stdout.write('{"owned":true}\n'); assert.equal(monitor.status().active, true);
  children[0].stdout.write('{"active":false}\n'); assert.equal(monitor.status().active, false);
});

test('malformed and null worker records cannot crash the main process', t => {
  const { monitor, children } = workerFixture(t);
  monitor.start();
  assert.doesNotThrow(() => children[0].stdout.write('null\n[]\n"text"\n{broken}\n'));
  children[0].stdout.write('{"active":true}\n'); assert.equal(monitor.status().active, true);
});

test('fullscreen watchdog and failed workers restore visible mode and release the child', async t => {
  const { monitor, children } = workerFixture(t, { watchdogMs: 25 });
  monitor.start(); children[0].stdout.write('{"active":true}\n');
  await waitFor(() => monitor.status().supported === false, 500);
  assert.equal(monitor.status().active, false); assert.equal(children[0].killed, 1);
  monitor.start(); const next = children[1]; next.stdout.write('{"active":true}\n');
  next.emit('error', new Error('test worker error'));
  assert.equal(monitor.status().active, false); assert.equal(next.killed, 1);
});

test('oversized worker output and stale events cannot re-enable fullscreen after stop', t => {
  const { monitor, children } = workerFixture(t);
  monitor.start(); const first = children[0];
  first.stdout.write('x'.repeat(9000));
  assert.equal(monitor.status().supported, false); assert.equal(first.killed, 1);
  monitor.start(); monitor.stop();
  first.stdout.emit('data', '{"active":true}\n'); first.emit('exit', 1);
  assert.equal(monitor.status().active, false);
});

test('non-Windows monitoring never spawns a helper and quick chat fits negative-coordinate screens', t => {
  let spawned = false;
  const monitor = new FullscreenMonitor({ platform: 'linux', spawnImpl: () => { spawned = true; } });
  t.after(() => monitor.stop()); monitor.start(); assert.equal(spawned, false); assert.equal(monitor.status().supported, false);
  const area = { x: -1280, y: -200, width: 1280, height: 680 };
  const bounds = quickChatBounds({ x: -1280, y: 100, width: 360, height: 500 }, area);
  assert.ok(bounds.x >= area.x && bounds.x + bounds.width <= area.x + area.width);
  assert.ok(bounds.y >= area.y && bounds.y + bounds.height <= area.y + area.height);
  const small = quickChatBounds({ x: 0, y: 0, width: 360, height: 500 }, { x: 0, y: 0, width: 300, height: 350 });
  assert.deepEqual(small, { x: 0, y: 0, width: 300, height: 350 });
});
