'use strict';

const api = window.petAPI;
const $ = id => document.getElementById(id);
let configDirty = false, connectionDirty = false, appearanceDirty = false, startupDirty = false, pendingChat = false, noticeTimer;
let currentName = '桌宠', currentConfig = {}, currentSettings = {};
let failedChat = null, chatContextGeneration = 0;
const receivedChatIds = new Set();
let activePage = 'home', unreadMessages = 0, focusGeneration = 0, connectionTestGeneration = 0;
let interactionReceivedAt = 0;
const cooldownEnds = new Map(), pendingActions = new Set(), pendingActionButtons = new Set();
const actionNames = { feed: '投喂', play: '摸摸', clean: '洗澡', sleep: '睡觉', wake: '唤醒', poke: '戳一戳' };

function notice(text, success = false) {
  clearTimeout(noticeTimer);
  const el = $('notice'); el.textContent = text; el.classList.toggle('success', success); el.hidden = !text;
  if (success) noticeTimer = setTimeout(() => { el.hidden = true; }, 7000);
}

async function perform(button, operation, successText) {
  if (button) button.disabled = true;
  try { const result = await operation(); if (successText) notice(successText, true); return result; }
  catch (error) { notice(error.message || '操作未完成，请重试。'); return null; }
  finally { if (button) button.disabled = false; }
}

function showPage(name) {
  if (activePage !== name) focusGeneration++;
  activePage = name;
  document.querySelectorAll('[data-page]').forEach(el => el.classList.toggle('active', el.dataset.page === name));
  document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === name));
  document.querySelector('main').scrollTop = 0;
  if (name === 'chat') $('chat-input').focus();
  window.dispatchEvent(new CustomEvent('pet:page', { detail: name }));
}

function applyState(state) {
  if (!state) return;
  for (const key of ['mood', 'satiety', 'cleanliness', 'energy']) {
    $(key + '-value').textContent = Math.round(state[key]);
    $(key + '-bar').style.width = `${state[key]}%`;
  }
  $('level').textContent = `Lv. ${state.level}`;
  $('exp').textContent = `经验 ${state.exp} / ${state.level * 100}`;
  $('state-sync').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  const lowest = Object.entries({ mood: state.mood, satiety: state.satiety, cleanliness: state.cleanliness, energy: state.energy }).sort((a, b) => a[1] - b[1])[0];
  $('hero-description').textContent = lowest[1] < 25 ? { mood: '想和你多待一会儿，摸摸我的头吧。', satiety: '肚子有点饿了，可以给我一点好吃的吗？', cleanliness: '想洗个香香的澡，再来陪你。', energy: '有点困了，陪我休息一下吧。' }[lowest[0]] : '今天状态不错，想陪你度过平凡又特别的一天。';
  const sleeping = Boolean(state.is_sleeping);
  $('sleep-action').dataset.action = sleeping ? 'wake' : 'sleep';
  $('sleep-action').querySelector('b').textContent = sleeping ? '唤醒' : '睡觉';
  $('sleep-action').querySelector('span').textContent = sleeping ? '☀️' : '🌙';
  if (sleeping) $('hero-description').textContent = '正在安静地睡觉，精力会慢慢恢复。';
  renderActionButtons();
}

function renderActionButtons() {
  for (const button of document.querySelectorAll('[data-action]')) {
    const action = button.dataset.action;
    const pending = pendingActions.has(action) || pendingActionButtons.has(button);
    const seconds = Math.max(0, Math.ceil(((cooldownEnds.get(action) || 0) - Date.now()) / 1000));
    button.disabled = pending || seconds > 0;
    button.setAttribute('aria-busy', String(pending));
    button.querySelector('.action-feedback').textContent = pending ? '处理中…' : seconds ? `${seconds} 秒后可用` : '';
    button.title = pending ? `${actionNames[action]}正在处理中` : seconds ? `冷却中，还需 ${seconds} 秒` : actionNames[action];
  }
}

function applyInteractions(data) {
  if (!data || !data.cooldowns || typeof data.cooldowns !== 'object') return;
  const receivedAt = Number.isFinite(data.received_at_ms) ? data.received_at_ms : Date.now();
  if (receivedAt < interactionReceivedAt) return;
  interactionReceivedAt = receivedAt;
  for (const action of Object.keys(actionNames)) {
    const seconds = Number(data.cooldowns[action] ?? 0);
    if (Number.isFinite(seconds)) cooldownEnds.set(action, receivedAt + Math.max(0, seconds) * 1000);
  }
  renderActionButtons();
}

async function runAction(button) {
  const action = button.dataset.action, generation = chatContextGeneration;
  if (button.disabled || pendingActions.has(action)) return;
  pendingActions.add(action); pendingActionButtons.add(button); renderActionButtons();
  $('action-status').textContent = `正在${actionNames[action]}，请稍等…`;
  try {
    const result = await api.action(action);
    if (generation !== chatContextGeneration) return;
    if (result?.interactions) applyInteractions(result.interactions);
    $('action-status').textContent = `${actionNames[action]}已完成。`;
  } catch (error) {
    if (generation !== chatContextGeneration) return;
    const retryAfter = Number(error.retry_after_sec);
    if (Number.isFinite(retryAfter) && retryAfter > 0) cooldownEnds.set(action, Date.now() + retryAfter * 1000);
    $('action-status').textContent = error.message || '互动未完成，请稍后再试。';
  } finally {
    if (generation === chatContextGeneration) {
      pendingActions.delete(action); pendingActionButtons.delete(button); renderActionButtons();
    }
  }
}

function applyStatus(status) {
  const phaseLabels = { online: '已连接', connecting: '连接中', retrying: '等待重连', auth_error: '令牌不匹配', offline: '未连接' };
  const label = phaseLabels[status.phase] || '未连接';
  $('side-status').textContent = label;
  $('connection-state').textContent = label;
  $('connection-message').textContent = status.message || '';
  for (const id of ['side-dot', 'connection-dot']) {
    $(id).classList.toggle('online', status.phase === 'online');
    $(id).classList.toggle('error', status.phase === 'auth_error');
  }
  if (status.phase !== 'online') $('state-sync').textContent = '离线 · 保留上次状态';
}

function applySettings(settings) {
  currentSettings = { ...currentSettings, ...settings };
  settings = currentSettings;
  if (!connectionDirty) {
    $('server').value = settings.server;
    $('token').placeholder = settings.tokenConfigured ? '已保存令牌，同地址留空保留' : '未设置令牌';
    $('token-note').textContent = settings.tokenUnavailable ? '原令牌暂时无法解密，请重新输入；未修改时会保留原加密数据。' : settings.tokenConfigured ? '令牌已加密保存在当前系统账户下；同地址留空会保留，更换地址需重新填写。' : '与 AstrBot 插件中的 auth_token 保持一致。';
  }
  if (!appearanceDirty) {
    $('scale').value = settings.scale;
    $('scale-value').textContent = Number(settings.scale).toFixed(2) + '×';
    $('always-on-top').checked = settings.alwaysOnTop;
    $('click-through').checked = settings.clickThrough;
  }
  $('model-name').textContent = settings.model?.name || '内置小猫';
  $('model-path').textContent = settings.model?.path || '没有外部模型时使用内置小猫。';
  $('quiet-mode').checked = Boolean(settings.quietMode);
  $('quiet-until').textContent = settings.muteUntil > Date.now() ? `临时安静到 ${new Date(settings.muteUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '聊天与主动互动不会被免打扰静音。';
  if (!startupDirty) {
    $('launch-at-login').checked = Boolean(settings.launchAtLogin);
    $('start-minimized').checked = Boolean(settings.startMinimized);
    $('quiet-on-fullscreen').checked = settings.quietOnFullscreen !== false;
  }
  $('launch-at-login').disabled = settings.startup?.supported === false;
  $('startup-status').textContent = settings.startup?.message || (settings.startup?.supported === false ? '当前环境不支持登录时启动。' : settings.startup?.enabled ? '系统已启用登录时启动。' : '系统未启用登录时启动。');
  $('fullscreen-status').textContent = settings.fullscreen?.message || (settings.fullscreen?.supported === false ? '当前环境不支持全屏检测。' : settings.fullscreen?.active ? '当前检测到全屏应用。' : '当前未检测到全屏应用。');
  updateConnectionTokenHint();
  if (settings.model?.error) notice(settings.model.error);
}

function personaVisibility() {
  const source = $('persona-source').value;
  $('custom-persona-row').hidden = source !== 'custom';
  $('selected-persona-row').hidden = source !== 'persona';
  $('persona-note').hidden = source === 'custom';
}

function applyConfig(config, force = false) {
  currentConfig = config;
  if (typeof config.pet_name === 'string') { currentName = config.pet_name; $('pet-name').textContent = currentName; }
  if (configDirty && !force) { $('config-status').textContent = '其他端设置已更新；本页未保存的修改仍保留。'; return; }
  const fields = { 'config-pet-name': ['pet_name', '桌宠'], 'persona-source': ['persona_source', 'custom'], 'persona-id': ['astrbot_persona_id', ''], persona: ['persona', ''], 'walk-speed': ['walk_speed', 1.5], 'sleepy-threshold': ['sleepy_threshold', 20], 'chatter-interval': ['chatter_interval_sec', 90] };
  for (const [id, [key, fallback]] of Object.entries(fields)) $(id).value = config[key] ?? fallback;
  for (const [id, key] of [['enable-roam', 'enable_roam'], ['enable-chatter', 'enable_chatter'], ['llm-action-reply', 'llm_action_reply']]) $(id).checked = config[key] ?? true;
  for (const [id, key] of [['chatter-lines', 'chatter_lines'], ['sleepy-lines', 'sleepy_lines']]) $(id).value = Array.isArray(config[key]) ? config[key].join('\n') : config[key] || '';
  personaVisibility();
  $('config-status').textContent = '当前设置已从插件同步。';
}

function markConfigDirty() { configDirty = true; $('config-dirty').hidden = false; $('config-status').textContent = '修改尚未保存到插件。'; }

function messagesAtBottom() {
  const list = $('messages');
  return list.scrollHeight - list.clientHeight - list.scrollTop <= 40;
}

function clearUnreadMessages() { unreadMessages = 0; $('new-messages').hidden = true; }
function scrollToLatest() { $('messages').scrollTop = $('messages').scrollHeight; clearUnreadMessages(); }

function appendMessage(text, role = 'assistant') {
  const list = $('messages'), follow = messagesAtBottom(), previousTop = list.scrollTop;
  $('chat-empty')?.remove();
  const message = document.createElement('div'); message.className = `message ${role}`;
  const label = document.createElement('span'); label.className = 'message-label'; label.textContent = role === 'user' ? '我' : role === 'error' ? '请求结果待确认' : currentName;
  const body = document.createElement('div'); body.className = 'message-body'; body.textContent = text;
  const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'message-copy'; copy.textContent = '复制'; copy.setAttribute('aria-label', `复制${role === 'user' ? '我的' : '这条'}消息`);
  copy.addEventListener('click', () => perform(copy, async () => {
    await api.copyText(String(text)); copy.textContent = '已复制';
    setTimeout(() => { if (copy.isConnected) copy.textContent = '复制'; }, 1800);
  }));
  const heading = document.createElement('div'); heading.className = 'message-heading'; heading.append(label, copy);
  message.append(heading, body); list.append(message);
  let removedHeight = 0;
  while (list.children.length > 100) { const first = list.firstElementChild; removedHeight += first.getBoundingClientRect().height + (parseFloat(getComputedStyle(first).marginBottom) || 0); first.remove(); }
  if (follow) scrollToLatest();
  else {
    list.scrollTop = Math.max(0, previousTop - removedHeight);
    unreadMessages++; $('new-messages').hidden = false; $('new-messages').textContent = `${unreadMessages} 条新消息 · 查看最新 ↓`;
  }
}

async function sendChat(event) {
  event?.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text || pendingChat) return;
  const retrying = failedChat && failedChat.text === text;
  const requestId = retrying ? failedChat.id : crypto.randomUUID();
  const generation = chatContextGeneration;
  const focusAtStart = focusGeneration;
  const restoreFocus = activePage === 'chat' && ['chat-input', 'send-chat', 'retry-chat'].includes(document.activeElement?.id);
  pendingChat = true; $('send-chat').disabled = true; $('chat-input').value = '';
  if (!retrying) appendMessage(text, 'user');
  $('chat-status').textContent = retrying ? '正在检查并继续原请求…' : '正在认真想怎么回复你…';
  try {
    const result = await api.chat(text, requestId);
    if (generation !== chatContextGeneration) return;
    if (!result.reply) appendMessage('（未收到文字回复）');
    failedChat = null; $('chat-recovery').hidden = true;
    $('chat-status').textContent = '回复已同步到桌宠气泡。';
  } catch (error) {
    if (generation !== chatContextGeneration) return;
    if (receivedChatIds.has(requestId)) {
      failedChat = null; $('chat-recovery').hidden = true;
      $('chat-status').textContent = '回复已通过实时连接收到。';
      return;
    }
    appendMessage(error.message, 'error');
    failedChat = { id: error.request_id || requestId, text };
    $('chat-recovery').hidden = false;
    $('chat-recovery-note').textContent = '结果尚未确认。检查结果不会再次调用模型；原文重试会沿用同一请求。';
    $('chat-status').textContent = '内容已保留，可以检查结果或重试原请求。';
    if (!$('chat-input').value) $('chat-input').value = text;
  } finally {
    if (generation === chatContextGeneration) {
      pendingChat = false; $('send-chat').disabled = false;
      if (restoreFocus && activePage === 'chat' && focusGeneration === focusAtStart && (document.activeElement === document.body || ['chat-input', 'send-chat', 'retry-chat'].includes(document.activeElement?.id))) $('chat-input').focus();
    }
  }
}

function canonicalServer(value) {
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(value.trim()) ? value.trim() : `http://${value.trim()}`);
    url.protocol = url.protocol === 'ws:' ? 'http:' : url.protocol === 'wss:' ? 'https:' : url.protocol;
    url.pathname = url.pathname.replace(/\/(?:ws|api\/state)\/?$/, '').replace(/\/+$/, '');
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch { return String(value || '').trim(); }
}

function connectionDraft() { return { server: $('server').value, token: $('token').value, clearToken: $('clear-token').checked }; }
function updateConnectionTokenHint() {
  const changed = canonicalServer($('server').value) !== canonicalServer(currentSettings.server || '');
  $('connection-token-hint').textContent = $('clear-token').checked ? '测试与保存时均不使用原令牌。' : $('token').value.trim() ? '测试与保存将使用本次填写的令牌。' : changed ? '地址已改变且未填写令牌：测试与保存均不沿用原服务器令牌；保存后会清除旧令牌。' : currentSettings.tokenConfigured ? '地址未改变，留空测试与保存时会保留已保存令牌。' : '本次测试与保存均不携带令牌。';
}

async function testConnection(button) {
  const generation = ++connectionTestGeneration, draft = connectionDraft();
  button.disabled = true; $('connection-test-results').hidden = false;
  $('connection-test-summary').textContent = '正在检测当前填写的地址与令牌…';
  for (const key of ['http', 'auth', 'websocket']) { const row = $('test-' + key); row.dataset.result = 'pending'; row.querySelector('span').textContent = '检测中…'; }
  try {
    const result = await api.testConnection(draft);
    if (generation !== connectionTestGeneration) return;
    $('connection-test-summary').textContent = result.message || '检测完成。当前连接与保存的设置没有改变。';
    for (const key of ['http', 'auth', 'websocket']) {
      const item = result[key] || {}, row = $('test-' + key);
      row.dataset.result = item.ok === true ? 'success' : item.ok === false ? 'error' : 'unknown';
      const label = item.ok === true ? '通过' : item.ok === false ? '失败' : '无法判断';
      row.querySelector('span').textContent = `${label}${item.message ? ' · ' + item.message : item.status ? ' · HTTP ' + item.status : ''}`;
    }
  } catch (error) {
    if (generation !== connectionTestGeneration) return;
    $('connection-test-summary').textContent = error.message || '未能完成检测。';
    for (const key of ['http', 'auth', 'websocket']) { $('test-' + key).dataset.result = 'unknown'; $('test-' + key).querySelector('span').textContent = '未完成'; }
  } finally { button.disabled = false; }
}

function recognizedVersion(value) {
  const match = typeof value === 'string' && /^v?(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?$/.exec(value.trim());
  return Boolean(match && match.slice(1, 4).every(part => Number.isSafeInteger(Number(part))));
}

function applyUpdates(result) {
  const checked = result.checkedAt;
  const date = new Date(typeof checked === 'number' && checked < 1e12 ? checked * 1000 : checked);
  $('update-last-checked').textContent = Number.isNaN(date.getTime()) ? '检查完成。' : `上次检查：${date.toLocaleString('zh-CN')}`;
  for (const kind of ['desktop', 'plugin']) {
    const item = result[kind] || { error: '没有收到检查结果，请稍后再试。' };
    if (item.current) $(kind + '-version-current').textContent = item.current;
    $(kind + '-version-latest').textContent = item.latest || '未获取';
    const status = $(kind + '-update-status'); status.classList.toggle('error', Boolean(item.error));
    status.textContent = item.error ? `检查失败：${item.error}` : !recognizedVersion(item.current) ? `当前安装版本未知，暂时无法比较版本。${item.message || '请连接插件或核对安装版本后再检查。'}` : !recognizedVersion(item.latest) ? '未能识别最新发行版本，请稍后再检查。' : item.available ? '有新版本，可打开发行页查看并手动下载。' : '当前已是最新版本，或正在使用更高版本。';
    const notes = $(kind + '-update-notes'); notes.textContent = typeof item.notes === 'string' ? item.notes : ''; notes.hidden = !notes.textContent;
  }
  const compatibility = result.compatibility, summary = $('update-compatibility');
  summary.hidden = !compatibility;
  if (compatibility) {
    const minimum = recognizedVersion(compatibility.minimumPlugin) ? compatibility.minimumPlugin : '未提供';
    summary.classList.toggle('error', compatibility.ok === false);
    summary.textContent = compatibility.ok === false ? `当前插件低于最低要求 ${minimum}，请先升级插件。` : compatibility.ok === true ? `已满足最低插件版本 ${minimum}；这不保证所有未来版本兼容。` : `当前插件版本未知，暂时无法判断是否满足最低要求 ${minimum}。`;
  }
}

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.view)));
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => runAction(button)));
setInterval(renderActionButtons, 250);
document.addEventListener('focusin', event => { if (!['chat-input', 'send-chat', 'retry-chat'].includes(event.target.id)) focusGeneration++; });
$('messages').addEventListener('scroll', () => { if (messagesAtBottom()) clearUnreadMessages(); });
$('new-messages').addEventListener('click', scrollToLatest);
$('chat-form').addEventListener('submit', sendChat);
$('chat-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendChat(); } });
$('clear-chat').addEventListener('click', () => { $('messages').replaceChildren(); clearUnreadMessages(); $('chat-status').textContent = '已清空本页显示，插件端的聊天上下文保留。'; });
$('retry-chat').addEventListener('click', () => { if (failedChat && !pendingChat) { $('chat-input').value = failedChat.text; sendChat(); } });
$('check-chat').addEventListener('click', event => perform(event.currentTarget, async () => {
  if (!failedChat) return;
  const pending = failedChat, generation = chatContextGeneration;
  const result = await api.requestStatus(pending.id, 'chat');
  if (generation !== chatContextGeneration) return;
  // The outer snapshot is current; result.result belongs to the cached request.
  if (result.interactions) applyInteractions(result.interactions);
  if (failedChat !== pending) return;
  if (result.status === 'completed') {
    failedChat = null; $('chat-recovery').hidden = true;
    if ($('chat-input').value.trim() === pending.text) $('chat-input').value = '';
    $('chat-status').textContent = '原请求已经完成，回复已找回。';
  } else if (result.status === 'pending') $('chat-recovery-note').textContent = '插件仍在处理原请求，请稍后再检查，无需重复发送。';
  else $('chat-recovery-note').textContent = '未找到原请求记录，可能尚未收到、已过期或服务重启。重试前请确认是否已经收到回复。';
}));
$('refresh-state').addEventListener('click', event => perform(event.currentTarget, () => api.getState(), '状态已刷新。'));
$('reconnect').addEventListener('click', event => perform(event.currentTarget, () => api.reconnect()));
$('test-connection').addEventListener('click', event => testConnection(event.currentTarget));
$('quit').addEventListener('click', () => api.quit());
$('reset-position').addEventListener('click', event => perform(event.currentTarget, () => api.resetPosition(), '桌宠已移回主屏幕。'));
$('choose-model').addEventListener('click', event => perform(event.currentTarget, () => api.chooseModel()));
$('default-model').addEventListener('click', event => perform(event.currentTarget, () => api.defaultModel()));

$('connection-form').addEventListener('input', () => {
  connectionDirty = true; connectionTestGeneration++; updateConnectionTokenHint();
  if (!$('connection-test-results').hidden) {
    $('connection-test-summary').textContent = '填写内容已改变，请重新测试。';
    for (const key of ['http', 'auth', 'websocket']) { $('test-' + key).dataset.result = 'unknown'; $('test-' + key).querySelector('span').textContent = '待重新测试'; }
  }
});
$('connection-form').addEventListener('submit', async event => {
  event.preventDefault();
  const result = await perform(event.submitter, () => api.saveSettings({ server: $('server').value, token: $('token').value, clearToken: $('clear-token').checked }));
  if (result) { connectionDirty = false; $('token').value = ''; $('clear-token').checked = false; applySettings(result); notice('连接设置已保存，正在连接插件。', true); }
});
$('appearance-form').addEventListener('input', () => { appearanceDirty = true; $('scale-value').textContent = Number($('scale').value).toFixed(2) + '×'; });
$('appearance-form').addEventListener('submit', async event => {
  event.preventDefault();
  const result = await perform(event.submitter, () => api.saveSettings({ scale: Number($('scale').value), alwaysOnTop: $('always-on-top').checked, clickThrough: $('click-through').checked }));
  if (result) { appearanceDirty = false; applySettings(result); notice('窗口设置已保存。', true); }
});
$('quiet-form').addEventListener('submit', event => { event.preventDefault(); perform(event.submitter, () => api.saveSettings({ quietMode: $('quiet-mode').checked }), '免打扰设置已保存。'); });
$('quiet-hour').addEventListener('click', event => perform(event.currentTarget, () => api.saveSettings({ muteUntil: Date.now() + 3600000 }), '接下来一小时安静陪伴。'));
$('quiet-resume').addEventListener('click', event => perform(event.currentTarget, () => api.saveSettings({ quietMode: false, muteUntil: 0 }), '已恢复提醒。'));
$('startup-form').addEventListener('input', () => { startupDirty = true; });
$('startup-form').addEventListener('submit', async event => {
  event.preventDefault();
  const value = { launchAtLogin: $('launch-at-login').checked, startMinimized: $('start-minimized').checked, quietOnFullscreen: $('quiet-on-fullscreen').checked };
  if ($('launch-at-login').disabled) delete value.launchAtLogin;
  const result = await perform(event.submitter, () => api.saveSettings(value));
  if (result) { startupDirty = false; applySettings(result); notice('启动与专注设置已保存。', true); }
});
$('check-updates').addEventListener('click', event => perform(event.currentTarget, async () => {
  $('update-last-checked').textContent = '正在检查两个发行仓库…';
  try { applyUpdates(await api.checkUpdates()); }
  catch (error) { $('update-last-checked').textContent = `检查未完成：${error.message || '请稍后再试。'}`; }
}));
document.querySelectorAll('[data-release]').forEach(button => button.addEventListener('click', () => perform(button, () => api.openRelease(button.dataset.release))));
$('behavior-form').addEventListener('input', markConfigDirty);
$('persona-source').addEventListener('change', personaVisibility);
$('behavior-form').addEventListener('submit', async event => {
  event.preventDefault();
  const value = {
    pet_name: $('config-pet-name').value.trim(), persona_source: $('persona-source').value,
    astrbot_persona_id: $('persona-id').value.trim(), persona: $('persona').value,
    llm_action_reply: $('llm-action-reply').checked, enable_roam: $('enable-roam').checked,
    walk_speed: Number($('walk-speed').value), sleepy_threshold: Number($('sleepy-threshold').value),
    enable_chatter: $('enable-chatter').checked, chatter_interval_sec: Number($('chatter-interval').value),
    chatter_lines: $('chatter-lines').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean),
    sleepy_lines: $('sleepy-lines').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  };
  if (!value.pet_name) { notice('请填写桌宠名字。'); return; }
  if (value.persona_source === 'persona' && !value.astrbot_persona_id) { notice('请选择或填写 AstrBot 人格 ID。'); return; }
  const result = await perform(event.submitter, () => api.saveConfig(value));
  if (result) { configDirty = false; $('config-dirty').hidden = true; applyConfig(result, true); notice('人格与行为设置已保存，并同步到所有已连接的桌面端。', true); }
});

$('refresh-personas').addEventListener('click', event => perform(event.currentTarget, async () => {
  const result = await api.personas(); $('persona-options').replaceChildren();
  for (const persona of result.personas || []) { const option = document.createElement('option'); option.value = persona.id; option.label = persona.name || persona.id; $('persona-options').append(option); }
  notice(result.personas?.length ? `已读取 ${result.personas.length} 个人格，可在输入栏中选择。` : '插件没有返回可选人格；你也可以直接输入已配置的人格 ID。', Boolean(result.personas?.length));
}));
document.querySelectorAll('[data-generate]').forEach(button => button.addEventListener('click', () => perform(button, async () => {
  const result = await api.generateLines(button.dataset.generate, 8);
  $(button.dataset.generate + '-lines').value = (result.lines || []).join('\n'); markConfigDirty();
  notice('台词已生成，确认后点击“保存并同步”。', true);
})));

api.onUpdate(message => {
  if (message.type === 'state') applyState(message.data);
  else if (message.type === 'status') applyStatus(message.data);
  else if (message.type === 'config') applyConfig(message.data);
  else if (message.type === 'settings') applySettings(message.data);
  else if (message.type === 'interactions') applyInteractions(message.data);
  else if (message.type === 'notice') notice(message.text);
  else if (message.type === 'connection_changed') {
    chatContextGeneration++; failedChat = null; pendingChat = false; receivedChatIds.clear();
    cooldownEnds.clear(); pendingActions.clear(); pendingActionButtons.clear(); interactionReceivedAt = 0;
    renderActionButtons(); clearUnreadMessages(); $('action-status').textContent = '连接设置已改变，等待互动状态同步。';
    $('send-chat').disabled = false; $('chat-recovery').hidden = true; $('messages').replaceChildren();
    $('chat-input').value = ''; $('chat-status').textContent = '连接设置已改变，等待重新连接。';
  }
  else if (message.type === 'speak') {
    if (message.source === 'chat' && message.request_id) {
      if (receivedChatIds.has(message.request_id)) return;
      receivedChatIds.add(message.request_id);
      if (receivedChatIds.size > 128) receivedChatIds.delete(receivedChatIds.values().next().value);
    }
    $('last-speech').textContent = message.text;
    appendMessage(message.text);
    if (failedChat && message.request_id === failedChat.id) {
      if ($('chat-input').value.trim() === failedChat.text) $('chat-input').value = '';
      failedChat = null; $('chat-recovery').hidden = true; $('chat-status').textContent = '刚才的回复已收到。';
    }
  }
});

api.snapshot().then(data => {
  applySettings(data.settings); applyState(data.state); applyStatus(data.status); applyConfig(data.config);
  applyInteractions(data.interactions);
  currentName = data.petName || currentName; $('pet-name').textContent = currentName;
  $('app-version').textContent = `v${data.appVersion}`;
  $('desktop-version-current').textContent = data.appVersion || '0.8.1';
  $('plugin-version-current').textContent = data.pluginVersion || '未连接 / 未知';
  if (data.notice) notice(data.notice);
}).catch(error => notice(error.message));
$('today').textContent = `${new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })} · 今天，也一起好好生活。`;
