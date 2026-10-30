'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, protocol, safeStorage, screen, globalShortcut, net, shell, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { DEFAULT_SETTINGS, PetConnection, normalizeSettings, atomicWriteJson, readJson } = require('./core');
const { petLayout, clampBounds, resizeAtFeet } = require('./geometry');
const { testConnection } = require('./diagnostics');
const { UpdateChecker } = require('./updates');
const { StartupController } = require('./startup');
const { FullscreenMonitor, quickChatBounds } = require('./fullscreen');

app.setName('AstrBot 桌宠');
if (process.env.PET_DATA_DIR) app.setPath('userData', path.resolve(process.env.PET_DATA_DIR));
protocol.registerSchemesAsPrivileged([{ scheme: 'petmodel', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

let control = null, pet = null, quickChat = null, tray = null, connection = null, quitting = false;
let startupController = null, fullscreenMonitor = null, updateChecker = null, diagnosticBusy = false;
let companionMode = { fullscreen: false };
let settings = { ...DEFAULT_SETTINGS }, token = '', preservedEncryptedToken = '', startupNotice = '', modelRoot = null;
let settingsPath, drag = null, positionTimer = null, roamingTimer = null, lastRoam = Date.now(), nextRoam = Date.now() + 15000, roamEnd = 0, direction = 1;
let pendingSettingsBackup = false;
let currentLayout = petLayout();
let currentMotion = 'idle';

function setMotion(state) {
  if (currentMotion !== state) { currentMotion = state; broadcast({ type: 'motion', state }); }
}

function broadcast(message) {
  for (const win of [control, pet, quickChat]) if (win && !win.isDestroyed()) win.webContents.send('pet:update', message);
}

function modelInfo() {
  let filename = settings.modelPath;
  if (!filename) {
    const bundled = path.join(app.getAppPath(), 'models', 'Haru', 'Haru.model3.json');
    if (fs.existsSync(bundled)) filename = bundled;
  }
  if (!filename) { modelRoot = null; return { url: '', name: '内置小猫', path: '' }; }
  try {
    const actual = fs.realpathSync(filename);
    if (!actual.toLowerCase().endsWith('.model3.json')) throw new Error('请选择 .model3.json 文件。');
    if (fs.statSync(actual).size > 2 * 1024 * 1024) throw new Error('模型描述文件过大。');
    const manifest = JSON.parse(fs.readFileSync(actual, 'utf8'));
    if (!manifest.FileReferences || typeof manifest.FileReferences.Moc !== 'string') throw new Error('模型缺少 Cubism 3/4 的 FileReferences.Moc。');
    modelRoot = path.dirname(actual);
    return { url: `petmodel://local/${encodeURIComponent(path.basename(actual))}`, name: path.basename(path.dirname(actual)), path: actual };
  } catch (error) { modelRoot = null; return { url: '', name: '内置小猫', path: filename, error: `模型无法载入：${error.message}` }; }
}

function publicSettings() { return { ...settings, layout: { ...currentLayout }, tokenConfigured: Boolean(token || preservedEncryptedToken), tokenUnavailable: Boolean(preservedEncryptedToken), model: modelInfo(), startup: startupController?.status() || { supported: false, enabled: false, message: '正在读取启动设置。' }, fullscreen: { ...(fullscreenMonitor?.status() || { supported: false, active: false }), active: companionMode.fullscreen, ...(!settings.quietOnFullscreen ? { message: '自动全屏安静已关闭。' } : {}) } }; }
function snapshot() { return { settings: publicSettings(), ...connection.snapshot(), companionMode: { ...companionMode }, notice: startupNotice, appVersion: app.getVersion() }; }

function applyCompanionMode() {
  if (quitting) return;
  const fullscreen = Boolean(settings.quietOnFullscreen && fullscreenMonitor?.status().active);
  connection?.setSpeechPolicy({ ...settings, fullscreenQuiet: fullscreen });
  if (fullscreen !== companionMode.fullscreen) {
    companionMode = { fullscreen }; stopDrag(); nextRoam = Date.now() + 15000; roamEnd = 0;
    broadcast({ type: 'companion_mode', data: { ...companionMode } });
    if (pet && !pet.isDestroyed()) fullscreen ? pet.hide() : pet.showInactive();
  }
}

function store(nextSettings = settings, nextToken = token, clearUnavailableToken = false) {
  let encryptedToken = clearUnavailableToken ? '' : preservedEncryptedToken;
  if (nextToken) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，令牌未保存。请检查系统密钥服务后重试。');
    encryptedToken = safeStorage.encryptString(nextToken).toString('base64');
  }
  if (pendingSettingsBackup && fs.existsSync(settingsPath)) {
    fs.copyFileSync(settingsPath, `${settingsPath}.legacy-backup-${Date.now()}`);
    pendingSettingsBackup = false;
  }
  atomicWriteJson(settingsPath, { version: 1, settings: nextSettings, encryptedToken });
  if (nextToken || clearUnavailableToken) preservedEncryptedToken = '';
}

function loadSettings() {
  try {
    const data = readJson(settingsPath, {});
    if (fs.existsSync(settingsPath) && (data.version !== 1 || !data.settings)) {
      pendingSettingsBackup = true;
      startupNotice = '已读取旧版设置；首次保存前会在同目录备份原文件，便于找回旧版字段。';
    }
    const source = data.settings || data;
    const legacy = { ...source };
    if (!legacy.server && typeof source.serverAddress === 'string') legacy.server = source.serverAddress;
    if (!legacy.server && typeof source.serverUrl === 'string') legacy.server = source.serverUrl;
    settings = normalizeSettings(legacy);
    if (typeof data.encryptedToken === 'string' && data.encryptedToken) {
      preservedEncryptedToken = data.encryptedToken;
      try {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据服务不可用');
        token = safeStorage.decryptString(Buffer.from(data.encryptedToken, 'base64'));
        preservedEncryptedToken = '';
      } catch { startupNotice = '原连接令牌暂时无法解密，已保留原加密数据。请在连接设置中重新输入令牌，或恢复原系统账户后重启。'; }
    } else if (typeof source.authToken === 'string') token = source.authToken;
    else if (typeof source.token === 'string') token = source.token;
  } catch (error) {
    pendingSettingsBackup = true;
    startupNotice = `读取原设置失败，已使用默认值。原文件仍保留：${error.message}`;
    settings = { ...DEFAULT_SETTINGS }; token = '';
  }
}

function safeBounds(x, y) {
  const display = screen.getDisplayNearestPoint({ x: Math.round(x + currentLayout.width / 2), y: Math.round(y + currentLayout.height - 6) });
  const area = display.workArea;
  const nextLayout = petLayout(settings.scale, area);
  setLayout(nextLayout);
  return clampBounds({ x, y, width: nextLayout.width, height: nextLayout.height }, area);
}

function setLayout(layout) {
  const changed = currentLayout.width !== layout.width || currentLayout.height !== layout.height || currentLayout.effectiveScale !== layout.effectiveScale;
  currentLayout = layout;
  if (changed && pet && !pet.isDestroyed()) broadcast({ type: 'layout', data: { ...layout } });
}

function resizePetAtFeet() {
  if (!pet || pet.isDestroyed()) return;
  const previous = pet.getBounds();
  const display = screen.getDisplayNearestPoint({ x: Math.round(previous.x + previous.width / 2), y: Math.round(previous.y + previous.height - 6) });
  const nextLayout = petLayout(settings.scale, display.workArea);
  setLayout(nextLayout);
  pet.setBounds(resizeAtFeet(previous, nextLayout, display.workArea));
  rememberPosition();
}

function rememberPosition() {
  clearTimeout(positionTimer);
  positionTimer = setTimeout(() => {
    if (!pet || pet.isDestroyed()) return;
    const [x, y] = pet.getPosition();
    const next = { ...settings, petX: x, petY: y };
    try { store(next); settings = next; } catch (error) { broadcast({ type: 'notice', text: `位置未保存：${error.message}` }); }
  }, 700);
}

function secureWindow(win, page) {
  const trusted = pathToFileURL(path.join(__dirname, page)).href;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (url !== trusted) event.preventDefault(); });
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.webContents.on('render-process-gone', () => { if (!quitting && !win.isDestroyed()) win.reload(); });
  win.loadFile(path.join(__dirname, page));
}

function createWindows() {
  const prefs = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true };
  control = new BrowserWindow({ width: 1120, height: 820, minWidth: 860, minHeight: 650, backgroundColor: '#f7f4ee', title: 'AstrBot 桌宠 · 控制台', show: false, webPreferences: { ...prefs } });
  control.removeMenu();
  control.once('ready-to-show', () => { if (!settings.startMinimized && !process.argv.includes('--background')) control.show(); });
  control.on('close', (event) => { if (!quitting && tray) { event.preventDefault(); control.hide(); } });
  secureWindow(control, 'control.html');
  const area = screen.getPrimaryDisplay().workArea;
  currentLayout = petLayout(settings.scale, area);
  const initial = safeBounds(settings.petX ?? area.x + area.width - currentLayout.width - 30, settings.petY ?? area.y + area.height - currentLayout.height);
  pet = new BrowserWindow({ ...initial, transparent: true, frame: false, resizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: settings.alwaysOnTop, show: false, backgroundColor: '#00000000', webPreferences: { ...prefs, backgroundThrottling: true } });
  pet.setIgnoreMouseEvents(settings.clickThrough, { forward: true });
  pet.once('ready-to-show', () => { if (!companionMode.fullscreen) pet.showInactive(); });
  pet.on('close', event => { if (!quitting) event.preventDefault(); });
  pet.on('blur', () => { if (drag) stopDrag(); });
  secureWindow(pet, 'pet.html');
}

function openControl() {
  if (!control || control.isDestroyed()) return;
  control.show(); control.restore(); control.focus();
}

function openQuickChat() {
  if (!pet || pet.isDestroyed()) return false;
  stopDrag(); roamEnd = 0; nextRoam = Date.now() + 15000;
  const petBounds = pet.getBounds();
  const area = screen.getDisplayNearestPoint({ x: Math.round(petBounds.x + petBounds.width / 2), y: Math.round(petBounds.y + petBounds.height / 2) }).workArea;
  const bounds = quickChatBounds(petBounds, area);
  const reveal = () => {
    if (quitting || !quickChat || quickChat.isDestroyed()) return;
    quickChat.show(); quickChat.focus(); quickChat.webContents.send('pet:update', { type: 'quickchat_opened' });
  };
  if (!quickChat || quickChat.isDestroyed()) {
    quickChat = new BrowserWindow({ ...bounds, frame: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false, skipTaskbar: true, show: false, title: 'AstrBot 桌宠 · 快聊', backgroundColor: '#f7f4ee', alwaysOnTop: settings.alwaysOnTop, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    quickChat.removeMenu(); quickChat.once('ready-to-show', reveal);
    quickChat.on('close', event => { if (!quitting) { event.preventDefault(); closeQuickChat(); } });
    secureWindow(quickChat, 'quickchat.html');
  } else { quickChat.setBounds(bounds); if (!quickChat.webContents.isLoadingMainFrame()) reveal(); }
  return true;
}

function closeQuickChat() {
  quickChat?.hide(); nextRoam = Date.now() + 15000; return true;
}

function createTray() {
  const pixels = Buffer.alloc(32 * 32 * 4);
  const pads = [[16, 21, 8], [6, 12, 4], [13, 7, 4], [22, 8, 4], [27, 15, 3]];
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    if (pads.some(([cx, cy, radius]) => Math.hypot(x - cx, y - cy) <= radius)) {
      const offset = (y * 32 + x) * 4;
      pixels[offset] = 83; pixels[offset + 1] = 133; pixels[offset + 2] = 103; pixels[offset + 3] = 255;
    }
  }
  const icon = nativeImage.createFromBitmap(pixels, { width: 32, height: 32 });
  tray = new Tray(icon);
  tray.setToolTip('AstrBot 桌宠');
  tray.on('double-click', openControl);
  updateTray();
}

function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '和桌宠聊聊天', click: openQuickChat },
    { label: '打开控制台', click: openControl },
    { label: '把桌宠移回屏幕', click: resetPosition },
    { type: 'separator' },
    ...[['feed', '投喂'], ['play', '摸摸'], ['clean', '洗澡'], ['sleep', '睡觉'], ['wake', '叫醒']].map(([action, label]) => ({ label, click: () => connection.action(action).catch(error => broadcast({ type: 'notice', text: error.message })) })),
    { type: 'separator' },
    { label: '鼠标穿透', type: 'checkbox', checked: settings.clickThrough, click: () => { try { saveSettings({ clickThrough: !settings.clickThrough }); } catch (error) { broadcast({ type: 'notice', text: error.message }); } } },
    { label: '免打扰（保留主动聊天）', type: 'checkbox', checked: settings.quietMode, click: () => { try { saveSettings({ quietMode: !settings.quietMode }); } catch (error) { broadcast({ type: 'notice', text: error.message }); } } },
    { label: '退出桌宠', click: () => { quitting = true; app.quit(); } }
  ]));
}

function resetPosition() {
  const area = screen.getPrimaryDisplay().workArea;
  setLayout(petLayout(settings.scale, area));
  pet.setBounds(safeBounds(area.x + area.width - currentLayout.width - 30, area.y + area.height - currentLayout.height));
  if (!companionMode.fullscreen) pet.showInactive(); rememberPosition();
  if (quickChat?.isVisible()) openQuickChat();
}

function saveSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置格式无效。');
  const clean = {};
  for (const key of ['server', 'scale', 'alwaysOnTop', 'clickThrough', 'quietMode', 'muteUntil', 'launchAtLogin', 'startMinimized', 'quietOnFullscreen']) if (key in patch) clean[key] = patch[key];
  const next = normalizeSettings(clean, settings);
  const serverChanged = next.server !== settings.server;
  // Testing a new address never reuses the previous server's credential;
  // saving that same draft must follow the same rule.
  let nextToken = serverChanged ? '' : token;
  if (patch.clearToken === true) nextToken = '';
  else if (typeof patch.token === 'string' && patch.token.length) {
    if (patch.token.length > 4096) throw new Error('令牌过长。');
    nextToken = patch.token.trim() || nextToken;
  }
  const previousStartup = startupController?.status();
  const startupChanged = 'launchAtLogin' in clean;
  try {
    if (startupChanged) startupController.setEnabled(next.launchAtLogin);
    store(next, nextToken, patch.clearToken === true || serverChanged);
  } catch (error) {
    if (startupChanged && previousStartup?.supported) {
      try { startupController.setEnabled(previousStartup.enabled); }
      catch { broadcast({ type: 'notice', text: '保存未完成，系统启动项恢复失败，请检查 Windows 启动应用设置。' }); }
    }
    throw error;
  }
  const reconnect = next.server !== settings.server || nextToken !== token;
  const resized = next.scale !== settings.scale;
  settings = next; token = nextToken;
  if (settings.quietOnFullscreen) fullscreenMonitor?.start(); else fullscreenMonitor?.stop();
  applyCompanionMode();
  pet.setAlwaysOnTop(settings.alwaysOnTop);
  pet.setIgnoreMouseEvents(settings.clickThrough, { forward: true });
  if (quickChat && !quickChat.isDestroyed()) quickChat.setAlwaysOnTop(settings.alwaysOnTop);
  if (resized) resizePetAtFeet();
  updateTray();
  broadcast({ type: 'settings', data: publicSettings() });
  if (reconnect) connection.configure(settings.server, token);
  return publicSettings();
}

function assertSender(event, petOnly = false) {
  const expected = petOnly ? [pet] : [control, pet, quickChat];
  if (!expected.some(win => win && !win.isDestroyed() && win.webContents === event.sender)) throw new Error('不允许的窗口请求。');
  const url = event.senderFrame?.url;
  if (!url || !['control.html', 'pet.html', 'quickchat.html'].map(page => pathToFileURL(path.join(__dirname, page)).href).includes(url)) throw new Error('不允许的页面请求。');
}

function handle(name, callback, petOnly = false) {
  ipcMain.handle(`pet:${name}`, async (event, ...args) => {
    try { assertSender(event, petOnly); return { ok: true, value: await callback(...args) }; }
    catch (error) { return { ok: false, error: { name: 'PetError', message: error.message || '操作未完成。', code: error.code || 'operation_failed', status: error.status || 0, request_id: error.request_id, retry_after_sec: error.retry_after_sec } }; }
  });
}

function registerIPC() {
  handle('snapshot', snapshot);
  handle('settings', saveSettings);
  handle('test-connection', async input => {
    if (diagnosticBusy) throw new Error('已有连接检测正在进行，请稍候。');
    diagnosticBusy = true;
    try { return await testConnection(input, { server: settings.server, token, tokenUnavailable: Boolean(preservedEncryptedToken) }, { fetchImpl: (...args) => net.fetch(...args) }); }
    finally { diagnosticBusy = false; }
  });
  handle('check-updates', () => updateChecker.check({ desktop: app.getVersion(), plugin: connection.pluginVersion }));
  handle('open-release', async kind => { await shell.openExternal(updateChecker.url(kind)); return true; });
  handle('copy-text', text => { if (typeof text !== 'string' || text.length > 20000) throw new Error('复制内容无效或过长。'); clipboard.writeText(text); return true; });
  handle('state', () => connection.getState());
  handle('reconnect', () => { connection.reconnect(); return true; });
  handle('action', (action, requestId) => connection.action(action, requestId));
  handle('chat', (text, requestId) => connection.chat(text, requestId));
  handle('request-status', (requestId, kind) => connection.requestStatus(requestId, kind));
  handle('config', config => connection.saveConfig(config));
  handle('personas', () => connection.personas());
  handle('generate-lines', (kind, count) => connection.generateLines(kind, count));
  handle('open-control', openControl);
  handle('open-quick-chat', openQuickChat);
  handle('close-quick-chat', closeQuickChat);
  handle('reset-position', resetPosition);
  handle('quit', () => { quitting = true; app.quit(); });
  handle('choose-model', async () => {
    const result = await dialog.showOpenDialog(control, { title: '选择 Live2D 模型描述文件', properties: ['openFile'], filters: [{ name: 'Live2D Cubism 模型', extensions: ['json'] }] });
    if (result.canceled) return null;
    const candidate = result.filePaths[0];
    if (!candidate.toLowerCase().endsWith('.model3.json')) throw new Error('请选择模型文件夹内的 .model3.json 文件；模型包请先解压。');
    const previous = settings;
    settings = { ...settings, modelPath: candidate };
    const info = modelInfo();
    if (info.error) { settings = previous; modelInfo(); throw new Error(info.error); }
    try { store(); } catch (error) { settings = previous; modelInfo(); throw error; }
    broadcast({ type: 'settings', data: publicSettings() });
    return publicSettings();
  });
  handle('default-model', () => {
    const next = { ...settings, modelPath: '' }; store(next); settings = next;
    broadcast({ type: 'settings', data: publicSettings() }); return publicSettings();
  });
  handle('drag-start', () => {
    const cursor = screen.getCursorScreenPoint(); const [x, y] = pet.getPosition();
    drag = { offsetX: cursor.x - x, offsetY: cursor.y - y, expires: Date.now() + 30000 };
  }, true);
  handle('drag-stop', stopDrag, true);
  handle('pet-active', () => { nextRoam = Date.now() + 15000; roamEnd = 0; setMotion(connection.state?.is_sleeping ? 'sleep' : 'idle'); }, true);
}

function stopDrag() { if (drag) { drag = null; rememberPosition(); nextRoam = Date.now() + 15000; roamEnd = 0; setMotion(connection.state?.is_sleeping ? 'sleep' : 'idle'); } }

function startMotion() {
  roamingTimer = setInterval(() => {
    const now = Date.now(); const elapsed = Math.min(0.1, (now - lastRoam) / 1000); lastRoam = now;
    if (!pet || pet.isDestroyed()) return;
    if (drag) {
      setMotion('drag');
      if (now > drag.expires) { stopDrag(); return; }
      const cursor = screen.getCursorScreenPoint();
      pet.setBounds(safeBounds(cursor.x - drag.offsetX, cursor.y - drag.offsetY)); return;
    }
    const cfg = connection.config;
    if (!cfg.enable_roam || !pet.isVisible() || quickChat?.isVisible() || companionMode.fullscreen || settings.clickThrough || connection.state?.is_sleeping || (connection.state && connection.state.energy < Number(cfg.sleepy_threshold ?? 20))) { roamEnd = 0; setMotion(connection.state?.is_sleeping ? 'sleep' : 'idle'); return; }
    if (now >= nextRoam && !roamEnd) { direction = Math.random() > 0.5 ? 1 : -1; roamEnd = now + 3000 + Math.random() * 4000; }
    if (!roamEnd) { setMotion('idle'); return; }
    if (now >= roamEnd) { roamEnd = 0; nextRoam = now + 15000 + Math.random() * 15000; rememberPosition(); setMotion('idle'); return; }
    setMotion('walk');
    const [x, y] = pet.getPosition();
    const speed = Math.max(0.2, Math.min(10, Number(cfg.walk_speed) || 1.5));
    const requestedX = x + direction * speed * 60 * elapsed;
    const bounds = safeBounds(requestedX, y);
    if (Math.abs(bounds.x - requestedX) > 1) direction *= -1;
    pet.setBounds(bounds);
  }, 50);
}

function registerModelProtocol() {
  const mime = { '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.moc3': 'application/octet-stream', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
  protocol.handle('petmodel', async request => {
    try {
      if (!modelRoot || request.method !== 'GET') return new Response('Not found', { status: 404 });
      const url = new URL(request.url);
      if (url.hostname !== 'local') return new Response('Forbidden', { status: 403 });
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (relative.includes('\0') || relative.includes('\\') || path.isAbsolute(relative)) return new Response('Forbidden', { status: 403 });
      const root = fs.realpathSync(modelRoot);
      const filename = fs.realpathSync(path.resolve(root, relative));
      const relation = path.relative(root, filename);
      if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) return new Response('Forbidden', { status: 403 });
      const contentType = mime[path.extname(filename).toLowerCase()];
      if (!contentType) return new Response('Forbidden', { status: 403 });
      const stat = fs.statSync(filename);
      if (!stat.isFile() || stat.size > 100 * 1024 * 1024) return new Response('Too large', { status: 413 });
      return new Response(await fs.promises.readFile(filename), { headers: { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', openControl);
  app.whenReady().then(() => {
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
    loadSettings();
    startupController = new StartupController(app);
    const startup = startupController.status(); if (startup.supported) settings.launchAtLogin = startup.enabled;
    updateChecker = new UpdateChecker({ fetchImpl: (...args) => net.fetch(...args) });
    connection = new PetConnection({ server: settings.server, token, speechPolicy: settings });
    connection.on('update', broadcast);
    fullscreenMonitor = new FullscreenMonitor({ onChange: () => { applyCompanionMode(); broadcast({ type: 'settings', data: publicSettings() }); } });
    registerModelProtocol(); createWindows(); createTray(); registerIPC();
    globalShortcut.register('CommandOrControl+Alt+P', openControl);
    screen.on('display-removed', resetPosition);
    screen.on('display-metrics-changed', () => { resizePetAtFeet(); if (quickChat?.isVisible()) openQuickChat(); });
    connection.start(); startMotion();
    if (settings.quietOnFullscreen) fullscreenMonitor.start();
  }).catch(error => { dialog.showErrorBox('AstrBot 桌宠启动失败', error.message); quitting = true; app.quit(); });
  app.on('activate', openControl);
  app.on('before-quit', () => {
    quitting = true; clearInterval(roamingTimer); clearTimeout(positionTimer);
    globalShortcut.unregisterAll(); fullscreenMonitor?.stop(); connection?.stop();
    if (pet && !pet.isDestroyed()) { const [x, y] = pet.getPosition(); settings.petX = x; settings.petY = y; }
    try { if (settingsPath) store(); } catch {}
    tray?.destroy(); tray = null;
  });
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
}
