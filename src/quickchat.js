'use strict';

const api = window.petAPI;
const $ = id => document.getElementById(id);
let generation = 0, activeRequest = null, failedRequest = null, checking = false, composing = false;
let compositionEndedAt = 0, currentName = '桌宠', unreadMessages = 0;
const receivedIds = new Set(), obsoleteIds = new Set();
const MAX_MESSAGES = 8;

function remember(set, value) {
  if (!value) return;
  set.add(value);
  while (set.size > 128) set.delete(set.values().next().value);
}

function status(text, error = false) {
  $('chat-status').textContent = text;
  $('chat-status').classList.toggle('error', error);
}

function refreshControls() {
  $('send-chat').disabled = checking || Boolean(activeRequest) || !$('chat-input').value.trim();
  $('send-chat').textContent = activeRequest ? '等待回复…' : '发送 ↗';
  $('chat-form').setAttribute('aria-busy', String(Boolean(activeRequest)));
  $('char-count').textContent = String($('chat-input').value.length);
  $('chat-recovery').hidden = !failedRequest;
  $('check-chat').disabled = checking || Boolean(activeRequest);
  $('retry-chat').disabled = checking || Boolean(activeRequest);
}

function nearLatest() {
  const main = document.querySelector('main');
  return main.scrollHeight - main.clientHeight - main.scrollTop <= 48;
}

function refreshUnread() {
  $('new-messages').hidden = unreadMessages === 0;
  $('new-messages').textContent = `有 ${unreadMessages} 条新消息 · 跳到最新 ↓`;
}

function showLatest() {
  const main = document.querySelector('main'); main.scrollTop = main.scrollHeight;
  unreadMessages = 0; refreshUnread();
}

function copyButton(text) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'message-copy'; button.textContent = '复制';
  button.setAttribute('aria-label', '复制这条回复'); button.title = '复制这条回复';
  const feedback = document.createElement('span'); feedback.className = 'sr-only'; feedback.setAttribute('role', 'status');
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      await api.copyText(text);
      if (!button.isConnected) return;
      button.textContent = '已复制'; feedback.textContent = '回复已复制。';
      button.title = '回复已复制'; button.setAttribute('aria-label', '回复已复制，再次复制');
    } catch (error) {
      if (!button.isConnected) return;
      button.textContent = '重试复制'; feedback.textContent = '复制失败，请重试。';
      button.title = error?.message || '复制失败，请重试。'; button.setAttribute('aria-label', '复制失败，点击重试');
    } finally { button.disabled = false; }
  });
  return [button, feedback];
}

function appendMessage(text, role) {
  if (typeof text !== 'string' || !text.trim()) return;
  const main = document.querySelector('main'), messages = $('messages');
  const follow = role === 'user' || nearLatest();
  const previousTop = main.scrollTop;
  // Anchor to a surviving message so pruning the oldest item does not move
  // the text currently being read. CSS disables native scroll anchoring.
  const removedCount = Math.max(0, messages.children.length + 1 - MAX_MESSAGES);
  const viewportTop = main.getBoundingClientRect().top;
  const anchor = follow ? null : Array.from(messages.children).slice(removedCount)
    .find(item => item.getBoundingClientRect().bottom > viewportTop);
  const anchorTop = anchor?.getBoundingClientRect().top;
  const content = text.slice(0, 12000);
  const row = document.createElement('article');
  row.className = `message ${role}`;
  const heading = document.createElement('div'); heading.className = 'message-heading';
  const label = document.createElement('span'); label.className = 'message-label';
  label.textContent = role === 'user' ? '你' : currentName;
  heading.append(label); if (role === 'assistant') heading.append(...copyButton(content));
  const body = document.createElement('p'); body.className = 'message-text'; body.textContent = content;
  row.append(heading, body); messages.append(row);
  const beforePruningHeight = main.scrollHeight;
  while (messages.children.length > MAX_MESSAGES) messages.firstElementChild.remove();
  $('empty-state').hidden = true;
  if (follow) showLatest();
  else {
    if (anchor?.isConnected) main.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    else main.scrollTop = Math.max(0, previousTop - (beforePruningHeight - main.scrollHeight));
    unreadMessages = Math.min(MAX_MESSAGES, unreadMessages + 1); refreshUnread();
  }
}

function focusInput() { $('chat-input').focus({ preventScroll: true }); }

async function sendChat(event, retry = false) {
  event?.preventDefault();
  if (activeRequest || checking || composing) return;
  const text = retry ? failedRequest?.text : $('chat-input').value.trim();
  if (!text) return;
  if (text.length > 4000) { status('每次最多发送 4000 字，可以分几次告诉我。', true); return; }
  const previous = failedRequest?.text === text ? failedRequest : null;
  const request = { id: previous?.id || crypto.randomUUID(), text, generation };
  activeRequest = request; failedRequest = null;
  if ($('chat-input').value.trim() === text) $('chat-input').value = '';
  if (!previous) appendMessage(text, 'user');
  status(previous ? '正在继续原请求…' : '正在认真想怎么回复你…');
  refreshControls();
  try {
    const result = await api.chat(text, request.id);
    if (request.generation !== generation) return;
    // Replies arrive through the shared speak stream, including HTTP recovery.
    // Appending result.reply here would duplicate that stream.
    status(result?.reply || receivedIds.has(request.id) ? '回复已收到，想说的话可以继续写。' : '这次没有收到文字回复。');
  } catch (error) {
    if (request.generation !== generation) return;
    if (receivedIds.has(request.id)) {
      status('回复已通过实时连接收到。');
      return;
    }
    if (error?.code === 'connection_changed') {
      remember(obsoleteIds, request.id);
      if (!$('chat-input').value) $('chat-input').value = text;
      status('连接已改变，内容已留作草稿，请确认后再发送。');
      return;
    }
    failedRequest = request;
    if (!$('chat-input').value) $('chat-input').value = text;
    $('recovery-note').textContent = '检查结果不会再次调用模型；重试会沿用原文与同一个请求。';
    status(error?.message || '暂时没有收到结果，可以稍后检查。', true);
  } finally {
    if (activeRequest === request) { activeRequest = null; refreshControls(); }
  }
}

async function checkRequest() {
  if (!failedRequest || activeRequest || checking) return;
  const request = failedRequest;
  checking = true; refreshControls();
  try {
    const result = await api.requestStatus(request.id, 'chat');
    if (request.generation !== generation) return;
    // A speak event can clear failedRequest before this promise resolves.
    if (failedRequest !== request && !receivedIds.has(request.id)) return;
    if (result.status === 'completed') {
      if (failedRequest === request) failedRequest = null;
      if ($('chat-input').value.trim() === request.text) $('chat-input').value = '';
      status('原请求已完成，回复已找回。');
    } else if (result.status === 'pending') {
      $('recovery-note').textContent = '插件还在处理原请求，稍后再检查即可，不必重复发送。';
    } else {
      $('recovery-note').textContent = '没有找到原请求，可能已过期或服务重启。重试前请确认是否已经收到回复。';
    }
  } catch (error) {
    if (request.generation === generation) status(error?.message || '暂时无法检查结果。', true);
  } finally {
    if (request.generation === generation) { checking = false; refreshControls(); }
  }
}

function changeConnection() {
  generation++;
  const draft = activeRequest?.text || failedRequest?.text;
  remember(obsoleteIds, activeRequest?.id); remember(obsoleteIds, failedRequest?.id);
  for (const id of receivedIds) remember(obsoleteIds, id);
  if (!$('chat-input').value && draft) $('chat-input').value = draft;
  activeRequest = null; failedRequest = null; checking = false; receivedIds.clear();
  $('messages').replaceChildren(); $('empty-state').hidden = false;
  unreadMessages = 0; refreshUnread(); document.querySelector('main').scrollTop = 0;
  status('连接已改变，草稿保留，请确认后再发送。');
  refreshControls();
}

function applyStatus(data = {}) {
  const labels = { online: '已连接', connecting: '正在连接', reconnecting: '正在重连', auth_error: '令牌需要检查', offline: '暂未连接', stopped: '暂未连接', error: '连接异常' };
  $('connection-status').className = `connection-status ${data.phase || ''}`;
  $('connection-status').textContent = labels[data.phase] || '正在连接';
  $('connection-status').title = data.message || '';
}

function setName(name) {
  if (typeof name !== 'string' || !name.trim()) return;
  currentName = name; $('pet-name').textContent = name; document.title = `和${name}聊一会儿`;
}

async function closeChat() {
  try { await api.closeQuickChat(); } catch (error) { status(error?.message || '暂时无法收起窗口。', true); }
}

$('chat-form').addEventListener('submit', sendChat);
$('new-messages').addEventListener('click', showLatest);
document.querySelector('main').addEventListener('scroll', () => {
  if (unreadMessages && nearLatest()) { unreadMessages = 0; refreshUnread(); }
});
$('chat-input').addEventListener('input', refreshControls);
$('chat-input').addEventListener('compositionstart', () => { composing = true; });
$('chat-input').addEventListener('compositionend', () => { composing = false; compositionEndedAt = Date.now(); refreshControls(); });
$('chat-input').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composing || event.keyCode === 229) return;
  // Some IMEs send a second Enter immediately after compositionend.
  if (Date.now() - compositionEndedAt < 150) return;
  event.preventDefault(); sendChat();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.isComposing && !composing && event.keyCode !== 229) { event.preventDefault(); closeChat(); }
});
$('close-chat').addEventListener('click', closeChat);
$('retry-chat').addEventListener('click', event => sendChat(event, true));
$('check-chat').addEventListener('click', checkRequest);
$('open-control').addEventListener('click', () => api.openControl().catch(error => status(error?.message || '无法打开控制台。', true)));
window.addEventListener('focus', focusInput);

api.onUpdate(message => {
  if (message.type === 'connection_changed') changeConnection();
  else if (message.type === 'status') applyStatus(message.data);
  else if (message.type === 'config') setName(message.data?.pet_name);
  else if (message.type === 'quickchat_opened') focusInput();
  else if (message.type === 'speak' && message.source === 'chat') {
    const id = message.request_id;
    if (id && (receivedIds.has(id) || obsoleteIds.has(id))) return;
    if (typeof message.text !== 'string' || !message.text.trim()) return;
    remember(receivedIds, id); appendMessage(message.text, 'assistant');
    if (failedRequest?.id === id) {
      if ($('chat-input').value.trim() === failedRequest.text) $('chat-input').value = '';
      failedRequest = null; status('刚才的回复已经收到。'); refreshControls();
    } else if (activeRequest?.id === id) status('回复已收到，正在确认请求完成。');
  }
});

const initialGeneration = generation;
api.snapshot().then(data => {
  if (generation !== initialGeneration) return;
  applyStatus(data.status); setName(data.petName || data.config?.pet_name); focusInput();
}).catch(error => status(error?.message || '暂时无法读取桌宠状态。', true));
