'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const core = require('../src/core');
const geometry = require('../src/geometry');
const { UpdateChecker } = require('../src/updates');
const { quickChatBounds } = require('../src/fullscreen');
const { version: appVersion } = require('../package.json');

const sourceDir = path.resolve(__dirname, '../src');
const source = fs.readFileSync(path.join(sourceDir, 'main.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

// Run the real main entry point and IPC wrappers. No Electron runtime, OS
// startup registration, helper process, socket or file write runs. Main-process
// timers are controlled by the harness instead of scheduling motion or saves.
async function boot(t, options = {}) {
  const windows = [], handlers = new Map(), timers = new Map(), shortcuts = new Map();
  const writes = [], copies = [], network = [], opened = [], clipboard = [], errors = [];
  const diagnosticCalls = [];
  let connection, monitor, startup, tray, timerId = 0;
  const files = { settings: { version: 1, settings: { ...core.DEFAULT_SETTINGS, ...options.settings } } };
  if (options.token) files.settings.encryptedToken = Buffer.from(options.token).toString('base64');
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };

  class Window extends EventEmitter {
    constructor(config) {
      super(); this.options = plain(config); this.visible = Boolean(config.show); this.destroyed = false;
      this.bounds = { x: 0, y: 0, width: 800, height: 600, ...config };
      this.shows = 0; this.inactiveShows = 0; this.hides = 0; this.focuses = 0; this.loading = true;
      this.messages = [];
      this.webContents = new EventEmitter();
      this.webContents.send = (channel, message) => this.messages.push({ channel, message: plain(message) });
      this.webContents.setWindowOpenHandler = fn => { this.openHandler = fn; };
      this.webContents.session = { setPermissionRequestHandler: fn => { this.permissionHandler = fn; } };
      this.webContents.isLoadingMainFrame = () => this.loading;
      windows.push(this);
    }
    loadFile(filename) { this.filename = filename; this.url = pathToFileURL(filename).href; return Promise.resolve(); }
    ready() { this.loading = false; this.emit('ready-to-show'); }
    removeMenu() {}
    show() { this.visible = true; this.shows++; }
    showInactive() { this.visible = true; this.inactiveShows++; }
    hide() { this.visible = false; this.hides++; }
    restore() { this.restored = true; }
    focus() { this.focuses++; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    getBounds() { return { x: this.bounds.x, y: this.bounds.y, width: this.bounds.width, height: this.bounds.height }; }
    getPosition() { return [this.bounds.x, this.bounds.y]; }
    setBounds(value) { this.bounds = { ...this.bounds, ...value }; }
    setAlwaysOnTop(value) { this.alwaysOnTop = value; }
    setIgnoreMouseEvents(value) { this.clickThrough = value; }
    reload() { this.reloads = (this.reloads || 0) + 1; }
    close() {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      this.emit('close', event); if (!event.prevented) this.destroyed = true;
      return event;
    }
  }
  class Connection extends EventEmitter {
    constructor(config) { super(); this.options = plain(config); this.config = { ...core.DEFAULT_BEHAVIOR }; this.state = null; this.pluginVersion = '0.5.1'; this.configured = []; this.policies = []; connection = this; }
    snapshot() { return { state: this.state, status: { phase: 'online' }, config: this.config, pluginVersion: this.pluginVersion }; }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    configure(server, token) { this.configured.push({ server, token }); }
    setSpeechPolicy(value) { this.policies.push(plain(value)); }
    action(action, requestId) { return Promise.resolve({ action, request_id: requestId }); }
    chat(text, requestId) { return Promise.resolve({ reply: text, request_id: requestId }); }
    requestStatus(requestId, kind) { return Promise.resolve({ status: 'unknown', request_id: requestId, kind }); }
  }
  class Startup {
    constructor() { this.enabled = options.startupEnabled || false; this.calls = []; startup = this; }
    status() { return { supported: true, enabled: this.enabled, message: 'mock system startup' }; }
    setEnabled(enabled) { this.calls.push(enabled); this.enabled = enabled; }
  }
  class Fullscreen {
    constructor({ onChange }) { this.onChange = onChange; this.active = false; this.starts = 0; this.stops = 0; monitor = this; }
    status() { return { supported: true, active: this.active, message: 'mock read-only monitor' }; }
    start() { this.starts++; }
    stop() { this.stops++; if (this.active) this.change(false); }
    change(active) { this.active = active; this.onChange(); }
  }
  class Tray extends EventEmitter {
    constructor() { super(); tray = this; }
    setToolTip(text) { this.tooltip = text; }
    setContextMenu(menu) { this.menu = menu; }
    destroy() { this.destroyed = true; }
  }

  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: true, name: '', quits: 0,
    setName(value) { this.name = value; }, setPath(name, value) { this[name] = value; },
    getPath: () => path.join(sourceDir, '__isolated_mock_userdata__'),
    getAppPath: () => path.dirname(sourceDir), getVersion: () => appVersion,
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    quit() { this.quits++; }
  });
  const screen = new EventEmitter();
  Object.assign(screen, { getPrimaryDisplay: () => ({ workArea }), getDisplayNearestPoint: () => ({ workArea }), getCursorScreenPoint: () => ({ x: 800, y: 500 }) });
  const electron = {
    app, BrowserWindow: Window, Tray, screen,
    Menu: { buildFromTemplate: items => items }, nativeImage: { createFromBitmap: () => ({}) },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog: { showErrorBox: (title, message) => errors.push({ title, message }), showOpenDialog: async () => ({ canceled: true }) },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => { if (options.decryptError) throw new Error('fixture decrypt unavailable'); return value.toString(); } },
    globalShortcut: { register: (name, fn) => shortcuts.set(name, fn), unregisterAll: () => shortcuts.clear() },
    shell: { openExternal: async url => { opened.push(url); } }, clipboard: { writeText: text => clipboard.push(text) },
    net: { fetch: async (...args) => {
      network.push(args);
      if (options.fetch) return options.fetch(...args);
      const plugin = String(args[0]).includes('astrbot_plugin_desktop_pet');
      const repo = plugin ? 'astrbot_plugin_desktop_pet' : 'astrbot-desktop-pet';
      const version = plugin ? '0.5.1' : '0.8.1';
      return new Response(JSON.stringify({ draft: false, prerelease: false, tag_name: `v${version}`, html_url: `https://github.com/iownmmiku/${repo}/releases/tag/v${version}`, body: 'Fixture release notes' }));
    } }
  };
  const fsMock = {
    existsSync: () => false,
    copyFileSync: (...args) => copies.push(args),
    realpathSync() { throw new Error('Model filesystem is isolated in this test.'); },
    statSync() { throw new Error('Unexpected filesystem stat.'); },
    readFileSync() { throw new Error('Unexpected filesystem read.'); },
    promises: { readFile: async () => { throw new Error('Unexpected model resource read.'); } }
  };
  const mocks = {
    electron, 'node:fs': fsMock, 'node:path': path, 'node:url': require('node:url'), './geometry': geometry,
    './core': {
      DEFAULT_SETTINGS: core.DEFAULT_SETTINGS, normalizeSettings: core.normalizeSettings, PetConnection: Connection,
      readJson: () => plain(files.settings),
      atomicWriteJson: (filename, value) => { writes.push({ filename, value: plain(value) }); if (options.writeError) throw new Error(options.writeError); }
    },
    './startup': { StartupController: Startup }, './fullscreen': { FullscreenMonitor: Fullscreen, quickChatBounds },
    './updates': { UpdateChecker },
    './diagnostics': { testConnection: async (input, saved, transport) => {
      diagnosticCalls.push({ input: plain(input), saved: plain(saved), transport });
      if (options.diagnostic) return options.diagnostic(input, saved, transport);
      return { server: input.server, http: { ok: true }, auth: { ok: true }, websocket: { ok: true } };
    } }
  };
  const setTimer = (fn, delay, interval) => { const id = ++timerId; timers.set(id, { fn, delay, interval }); return id; };
  vm.runInNewContext(source, {
    require(id) { assert.ok(Object.hasOwn(mocks, id), `Unexpected require: ${id}`); return mocks[id]; },
    __dirname: sourceDir, Buffer, URL, Response,
    process: { env: {}, argv: ['electron', sourceDir, ...(options.argv || [])] },
    setTimeout: (fn, delay) => setTimer(fn, delay, false), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => setTimer(fn, delay, true), clearInterval: id => timers.delete(id)
  }, { filename: path.join(sourceDir, 'main.js') });
  await tick();
  assert.deepEqual(errors, [], 'main startup should succeed with the isolated Electron adapters');
  if (options.autoReady !== false) for (const win of windows) win.ready();
  t.after(() => { app.emit('before-quit'); timers.clear(); });
  const windowFor = name => windows.find(win => path.basename(win.filename) === `${name}.html` && !win.destroyed);
  const eventFor = win => ({ sender: win.webContents, senderFrame: { url: win.url } });
  const invokeEvent = async (name, event, ...args) => {
    const handler = handlers.get(`pet:${name}`); assert.ok(handler, `Missing IPC registration: ${name}`);
    return handler(event, ...args);
  };
  const invoke = (name, win, ...args) => invokeEvent(name, eventFor(win), ...args);
  return { app, windows, windowFor, invoke, invokeEvent, eventFor, connection, monitor, startup, tray, writes, copies, network, opened, clipboard, diagnosticCalls, shortcuts, timers };
}

test('main lazily creates one secure quick-chat window and reuses it after hiding', async t => {
  const h = await boot(t), pet = h.windowFor('pet'), control = h.windowFor('control');
  assert.equal(h.windows.length, 2);
  assert.equal(h.windowFor('quickchat'), undefined);
  assert.equal((await h.invoke('open-quick-chat', pet)).ok, true);
  const quick = h.windowFor('quickchat'); assert.equal(h.windows.length, 3); assert.equal(quick.visible, false);
  assert.deepEqual(quick.options.webPreferences, { preload: path.join(sourceDir, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true });
  assert.equal(quick.options.skipTaskbar, true); assert.equal(quick.options.show, false);
  quick.ready(); assert.equal(quick.visible, true); assert.equal(quick.focuses, 1);
  assert.ok(quick.messages.some(({ message }) => message.type === 'quickchat_opened'));
  assert.deepEqual(plain(quick.openHandler({ url: 'https://untrusted.example' })), { action: 'deny' });
  let permitted; quick.permissionHandler(null, 'media', allowed => { permitted = allowed; }); assert.equal(permitted, false);
  const navigation = { prevented: false, preventDefault() { this.prevented = true; } };
  quick.webContents.emit('will-navigate', navigation, 'https://untrusted.example'); assert.equal(navigation.prevented, true);
  assert.equal(quick.close().prevented, true); assert.equal(quick.destroyed, false); assert.equal(quick.visible, false);
  pet.setBounds({ x: 200, y: 250 });
  assert.equal((await h.invoke('open-quick-chat', control)).ok, true);
  assert.equal(h.windows.length, 3); assert.equal(quick.visible, true); assert.equal(quick.focuses, 2);
  assert.ok(quick.getBounds().x >= 0); assert.ok(quick.getBounds().x + quick.getBounds().width <= 1920);
  assert.equal((await h.invoke('close-quick-chat', quick)).ok, true); assert.equal(quick.visible, false);
});

test('main IPC rejects unknown senders, foreign frames and non-pet drag requests', async t => {
  const h = await boot(t), control = h.windowFor('control'), pet = h.windowFor('pet');
  const unknown = await h.invokeEvent('open-quick-chat', { sender: new EventEmitter(), senderFrame: { url: control.url } });
  assert.equal(unknown.ok, false); assert.match(unknown.error.message, /窗口请求/);
  const foreign = await h.invokeEvent('settings', { sender: control.webContents, senderFrame: { url: 'https://untrusted.example' } }, { launchAtLogin: true });
  assert.equal(foreign.ok, false); assert.equal(h.startup.calls.length, 0); assert.equal(h.writes.length, 0);
  const missingFrame = await h.invokeEvent('snapshot', { sender: control.webContents }); assert.equal(missingFrame.ok, false);
  const wrongWindow = await h.invoke('drag-start', control); assert.equal(wrongWindow.ok, false);
  await h.invoke('open-quick-chat', pet); const quick = h.windowFor('quickchat'); quick.ready();
  assert.equal((await h.invoke('pet-active', quick)).ok, false);
  assert.equal((await h.invoke('snapshot', quick)).ok, true);
  assert.equal((await h.invoke('drag-start', pet)).ok, true);
  assert.equal((await h.invoke('drag-stop', pet)).ok, true);
});

test('temporary connection diagnostics receive the draft and never persist or configure the active connection', async t => {
  const h = await boot(t, { settings: { server: 'https://saved.example/pet' }, token: 'fixture-token', diagnostic: async (input, saved, transport) => {
    assert.equal(saved.server, 'https://saved.example/pet'); assert.equal(saved.token, 'fixture-token');
    await transport.fetchImpl('https://diagnostic.example/fixture');
    return { http: { ok: true }, auth: { ok: false }, websocket: { ok: false }, server: input.server };
  } });
  const draft = { server: 'https://draft.example/new', token: '', clearToken: false }, control = h.windowFor('control');
  const result = await h.invoke('test-connection', control, draft);
  assert.equal(result.ok, true); assert.equal(result.value.auth.ok, false);
  assert.deepEqual(h.diagnosticCalls[0].input, draft);
  assert.equal(h.network[0][0], 'https://diagnostic.example/fixture', 'diagnostic fetch is routed through Electron net');
  assert.equal(h.writes.length, 0); assert.equal(h.connection.configured.length, 0); assert.equal(h.startup.calls.length, 0);
  assert.equal((await h.invoke('snapshot', control)).value.settings.server, 'https://saved.example/pet');
});

test('connection diagnostic single-flight is released even when the helper rejects', async t => {
  let reject;
  const h = await boot(t, { diagnostic: () => new Promise((_, no) => { reject = no; }) }), control = h.windowFor('control');
  const draft = { server: 'https://draft.example' };
  const first = h.invoke('test-connection', control, draft);
  const second = await h.invoke('test-connection', control, draft);
  assert.equal(second.ok, false); assert.match(second.error.message, /已有连接检测/); assert.equal(h.diagnosticCalls.length, 1);
  reject(new Error('fixture diagnostic failure')); assert.equal((await first).ok, false);
  const third = h.invoke('test-connection', control, draft); assert.equal(h.diagnosticCalls.length, 2);
  reject(new Error('fixture second failure')); assert.equal((await third).ok, false);
  assert.equal(h.writes.length, 0); assert.equal(h.connection.configured.length, 0);
});

test('update lookup is manual and release IPC only opens official project URLs', async t => {
  const h = await boot(t), control = h.windowFor('control');
  assert.equal(h.network.length, 0); assert.equal(h.opened.length, 0);
  await h.invoke('snapshot', control); await h.invoke('open-quick-chat', control);
  assert.equal(h.network.length, 0, 'normal app and window startup must not check releases');
  const result = await h.invoke('check-updates', control);
  assert.equal(result.ok, true); assert.equal(result.value.desktop.current, appVersion); assert.equal(result.value.plugin.current, '0.5.1');
  assert.equal(h.network.length, 2); assert.ok(h.network.every(([url]) => String(url).startsWith('https://api.github.com/repos/iownmmiku/')));
  for (const invalid of ['https://evil.example/download.exe', '__proto__', 'constructor', 'other']) {
    assert.equal((await h.invoke('open-release', control, invalid)).ok, false);
  }
  assert.equal(h.opened.length, 0);
  assert.equal((await h.invoke('open-release', control, 'desktop')).ok, true);
  assert.equal((await h.invoke('open-release', control, 'plugin')).ok, true);
  assert.deepEqual(h.opened, ['https://github.com/iownmmiku/astrbot-desktop-pet/releases/tag/v0.8.1', 'https://github.com/iownmmiku/astrbot_plugin_desktop_pet/releases/tag/v0.5.1']);
  assert.equal(h.writes.length, 0); assert.equal(h.connection.configured.length, 0);
});

test('malicious release metadata cannot escape the project whitelist through main IPC', async t => {
  const h = await boot(t, { fetch: async () => new Response(JSON.stringify({ draft: false, prerelease: false, tag_name: 'v9.0.0', html_url: 'https://evil.example/pet.exe', body: 'Untrusted response' })) });
  const control = h.windowFor('control');
  const result = await h.invoke('check-updates', control); assert.equal(result.ok, true);
  assert.ok(result.value.desktop.error); assert.ok(result.value.plugin.error);
  assert.equal((await h.invoke('open-release', control, 'desktop')).ok, true);
  assert.deepEqual(h.opened, ['https://github.com/iownmmiku/astrbot-desktop-pet/releases/latest']);
});

test('fullscreen mode hides and restores the pet without activating it or changing the control window', async t => {
  const h = await boot(t), pet = h.windowFor('pet'), control = h.windowFor('control');
  assert.equal(h.monitor.starts, 1); assert.equal(pet.visible, true);
  const shows = pet.inactiveShows, controlShows = control.shows;
  h.monitor.change(true);
  assert.equal(pet.visible, false); assert.equal(control.visible, true);
  assert.equal(h.connection.policies.at(-1).fullscreenQuiet, true);
  assert.equal((await h.invoke('snapshot', control)).value.companionMode.fullscreen, true);
  assert.ok(pet.messages.some(({ message }) => message.type === 'companion_mode' && message.data.fullscreen));
  h.monitor.change(false);
  assert.equal(pet.visible, true); assert.equal(pet.inactiveShows, shows + 1); assert.equal(pet.focuses, 0);
  assert.equal(control.shows, controlShows); assert.equal(h.connection.policies.at(-1).fullscreenQuiet, false);
  h.monitor.change(true);
  const saved = await h.invoke('settings', control, { quietOnFullscreen: false });
  assert.equal(saved.ok, true); assert.equal(h.monitor.stops, 1); assert.equal(pet.visible, true);
  h.monitor.change(true);
  assert.equal(pet.visible, true, 'turning off the preference wins over a later monitor notification');
  assert.equal(h.connection.policies.at(-1).fullscreenQuiet, false);
});

test('start-minimized and background launches keep the pet and tray available without showing the control window', async t => {
  for (const options of [{ settings: { startMinimized: true } }, { argv: ['--background'] }]) {
    await t.test(options.argv ? 'background argument' : 'saved preference', async child => {
      const h = await boot(child, options), control = h.windowFor('control');
      assert.equal(control.visible, false); assert.equal(h.windowFor('pet').visible, true); assert.ok(h.tray.menu.length);
      assert.deepEqual(h.startup.calls, [], 'starting the app must not rewrite OS startup settings');
      h.shortcuts.get('CommandOrControl+Alt+P')();
      assert.equal(control.visible, true); assert.equal(control.focuses, 1);
    });
  }
});

test('failed settings persistence rolls back the OS startup preference and leaves the live connection unchanged', async t => {
  const h = await boot(t, { writeError: 'fixture disk full' }), control = h.windowFor('control');
  const result = await h.invoke('settings', control, { launchAtLogin: true, startMinimized: true, server: 'https://new.example/pet', token: 'new-fixture-token' });
  assert.equal(result.ok, false); assert.match(result.error.message, /disk full/);
  assert.deepEqual(h.startup.calls, [true, false]); assert.equal(h.startup.enabled, false);
  assert.equal(h.writes.length, 1); assert.equal(h.connection.configured.length, 0);
  const snapshot = (await h.invoke('snapshot', control)).value;
  assert.equal(snapshot.settings.launchAtLogin, false); assert.equal(snapshot.settings.startMinimized, false);
  assert.equal(snapshot.settings.server, core.DEFAULT_SETTINGS.server); assert.equal(snapshot.settings.tokenConfigured, false);
});

test('shutdown stops fullscreen monitoring and the connection without revealing a pending quick-chat window', async t => {
  const h = await boot(t), control = h.windowFor('control');
  await h.invoke('open-quick-chat', control); const quick = h.windowFor('quickchat');
  h.app.emit('before-quit'); quick.ready();
  assert.equal(quick.visible, false); assert.equal(h.monitor.stops, 1); assert.equal(h.connection.stopped, true);
  assert.equal(h.tray.destroyed, true); assert.equal(h.shortcuts.size, 0); assert.equal(h.timers.size, 0);
});

test('saving a new server with a blank token clears both the live credential and encrypted archive', async t => {
  const h = await boot(t, { settings: { server: 'https://saved.example/pet' }, token: 'old-fixture-token' }), control = h.windowFor('control');
  const result = await h.invoke('settings', control, { server: 'https://new.example/pet', token: '', clearToken: false });
  assert.equal(result.ok, true); assert.equal(result.value.tokenConfigured, false);
  assert.deepEqual(h.connection.configured, [{ server: 'https://new.example/pet', token: '' }]);
  assert.equal(h.writes.at(-1).value.encryptedToken, '');
});

test('saving a new server accepts an explicitly supplied new token without reusing the original', async t => {
  const h = await boot(t, { settings: { server: 'https://saved.example/pet' }, token: 'old-fixture-token' }), control = h.windowFor('control');
  const result = await h.invoke('settings', control, { server: 'https://new.example/pet', token: 'new-fixture-token', clearToken: false });
  assert.equal(result.ok, true); assert.equal(result.value.tokenConfigured, true);
  assert.deepEqual(h.connection.configured, [{ server: 'https://new.example/pet', token: 'new-fixture-token' }]);
  assert.equal(Buffer.from(h.writes.at(-1).value.encryptedToken, 'base64').toString(), 'new-fixture-token');
});

test('saving the same normalized server with a blank token preserves its credential', async t => {
  const h = await boot(t, { settings: { server: 'https://saved.example/pet' }, token: 'old-fixture-token' }), control = h.windowFor('control');
  for (const token of ['', '   ']) {
    const result = await h.invoke('settings', control, { server: 'wss://saved.example/pet/ws', token, clearToken: false });
    assert.equal(result.ok, true); assert.equal(result.value.tokenConfigured, true);
    assert.equal(h.connection.configured.length, 0);
    assert.equal(Buffer.from(h.writes.at(-1).value.encryptedToken, 'base64').toString(), 'old-fixture-token');
  }
});

test('switching server clears an undecryptable old token while an unchanged server preserves it', async t => {
  const h = await boot(t, { settings: { server: 'https://saved.example/pet' }, token: 'encrypted-old-fixture', decryptError: true }), control = h.windowFor('control');
  const same = await h.invoke('settings', control, { server: 'https://saved.example/pet', token: '' });
  assert.equal(same.ok, true); assert.equal(same.value.tokenUnavailable, true);
  assert.equal(h.writes.at(-1).value.encryptedToken, Buffer.from('encrypted-old-fixture').toString('base64'));
  const changed = await h.invoke('settings', control, { server: 'https://new.example/pet', token: '' });
  assert.equal(changed.ok, true); assert.equal(changed.value.tokenConfigured, false); assert.equal(changed.value.tokenUnavailable, false);
  assert.equal(h.writes.at(-1).value.encryptedToken, '');
  assert.deepEqual(h.connection.configured, [{ server: 'https://new.example/pet', token: '' }]);
});
