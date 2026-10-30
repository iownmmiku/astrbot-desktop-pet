'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { speechAllowed } = require('./speech_queue');

const DEFAULT_SETTINGS = Object.freeze({ server: 'http://127.0.0.1:9898', modelPath: '', scale: 1, alwaysOnTop: true, clickThrough: false, quietMode: false, muteUntil: 0, petX: null, petY: null });
const ACTIONS = new Set(['feed', 'clean', 'play', 'sleep', 'wake', 'poke']);
const DEFAULT_BEHAVIOR = Object.freeze({ enable_chatter: true, chatter_lines: ['忙完了就陪我玩一会儿吧。', '我在这里陪你。'], chatter_interval_sec: 90, sleepy_lines: ['有一点困了……'], walk_speed: 1.5, sleepy_threshold: 20, enable_roam: true });

function normalizeServer(input) {
  if (typeof input !== 'string' || input.length > 2048 || !input.trim()) throw new Error('请输入插件服务器地址。');
  let value = input.trim();
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) value = `http://${value}`;
  let url;
  try { url = new URL(value); } catch { throw new Error('服务器地址格式无效。'); }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error('请使用 http(s) 或 ws(s) 地址，令牌请填入单独的令牌栏。');
  url.protocol = ({ 'ws:': 'http:', 'wss:': 'https:' })[url.protocol] || url.protocol;
  url.pathname = url.pathname.replace(/\/(?:ws|api\/state)\/?$/, '').replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

function endpoint(server, route, websocket = false) {
  const base = normalizeServer(server);
  const url = new URL(`${base}/${route.replace(/^\/+/, '')}`);
  if (websocket) url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function normalizeSettings(input = {}, previous = DEFAULT_SETTINGS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置必须是对象。');
  const result = { ...DEFAULT_SETTINGS, ...previous };
  if ('server' in input) result.server = normalizeServer(input.server);
  if ('modelPath' in input) {
    if (typeof input.modelPath !== 'string' || input.modelPath.length > 4096) throw new Error('模型路径无效。');
    result.modelPath = input.modelPath;
  }
  if ('scale' in input) {
    if (typeof input.scale !== 'number' || !Number.isFinite(input.scale) || input.scale < 0.5 || input.scale > 2) throw new Error('模型缩放须在 0.5–2 倍之间。');
    result.scale = input.scale;
  }
  for (const key of ['alwaysOnTop', 'clickThrough', 'quietMode']) {
    if (key in input) {
      if (typeof input[key] !== 'boolean') throw new Error(`${key} 必须是开关值。`);
      result[key] = input[key];
    }
  }
  if ('muteUntil' in input) {
    if (!Number.isSafeInteger(input.muteUntil) || input.muteUntil < 0) throw new Error('免打扰结束时间无效。');
    result.muteUntil = input.muteUntil;
  }
  for (const key of ['petX', 'petY']) if (key in input && (input[key] === null || Number.isSafeInteger(input[key]))) result[key] = input[key];
  return result;
}

function atomicWriteJson(filename, data) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function readJson(filename, fallback) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { ...fallback };
    if (error instanceof SyntaxError) {
      fs.copyFileSync(filename, `${filename}.corrupt-${Date.now()}`);
      return { ...fallback };
    }
    throw error;
  }
}

function validObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sanitizeState(state) {
  if (!validObject(state)) return null;
  const result = {};
  for (const key of ['mood', 'satiety', 'cleanliness', 'energy']) {
    if (typeof state[key] !== 'number' || !Number.isFinite(state[key])) return null;
    result[key] = Math.max(0, Math.min(100, state[key]));
  }
  for (const key of ['exp', 'level']) {
    if (!Number.isSafeInteger(state[key]) || state[key] < (key === 'level' ? 1 : 0)) return null;
    result[key] = state[key];
  }
  if ('is_sleeping' in state) result.is_sleeping = state.is_sleeping === true;
  if ('sleep_started_at' in state) result.sleep_started_at = typeof state.sleep_started_at === 'number' && Number.isFinite(state.sleep_started_at) && state.sleep_started_at >= 0 ? state.sleep_started_at : null;
  return result;
}

class PetError extends Error {
  constructor(message, { code = 'request_failed', status = 0, request_id } = {}) {
    super(message); this.name = 'PetError'; this.code = code; this.status = status;
    if (request_id) this.request_id = request_id;
  }
}
function validateRequestId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new PetError('请求 ID 无效。', { code: 'invalid_request' });
  return value;
}

class PetConnection extends EventEmitter {
  constructor({ server = DEFAULT_SETTINGS.server, token = '', fetchImpl = globalThis.fetch, WebSocketImpl, random = Math.random, requestTimeout = 65000, speechPolicy = {} } = {}) {
    super();
    this.server = normalizeServer(server);
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl || require('ws');
    this.random = random;
    this.requestTimeout = requestTimeout;
    this.defaultRequestTimeout = requestTimeout;
    this.timeoutNegotiated = false;
    this.healthPromise = null;
    this.speechPolicy = { ...speechPolicy };
    this.state = null;
    this.stateRevision = -1;
    this.stateEpoch = 0;
    this.seenSpeech = new Map();
    this.config = { ...DEFAULT_BEHAVIOR };
    this.configEpoch = 0;
    this.petName = '桌宠';
    this.status = { phase: 'offline', message: '尚未连接' };
    this.generation = 0;
    this.attempt = 0;
    this.controllers = new Set();
    this.ws = null;
    this.retryTimer = null;
    this.heartbeat = null;
    this.helloTimer = null;
    this.stopped = true;
  }

  snapshot() { return { state: this.state && { ...this.state }, config: { ...this.config }, petName: this.petName, status: { ...this.status }, requestTimeoutMs: this.requestTimeout }; }
  setSpeechPolicy(policy) { this.speechPolicy = { quietMode: policy.quietMode === true, muteUntil: Number.isFinite(policy.muteUntil) ? policy.muteUntil : 0 }; }
  negotiateTimeout(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return;
    this.requestTimeout = Math.max(5000, Math.min(210000, Math.ceil(seconds * 1000) + 5000));
    this.timeoutNegotiated = true;
  }
  async ensureTimeout() {
    if (this.timeoutNegotiated) return;
    if (!this.healthPromise) {
      const generation = this.generation;
      const pending = this.request('GET', 'api/health', undefined, Math.min(5000, this.requestTimeout))
        .then(result => { if (generation === this.generation) { this.negotiateTimeout(result.request_timeout_sec); this.timeoutNegotiated = true; } })
        .catch(error => { if (generation !== this.generation) throw error; if (error.status === 404) this.timeoutNegotiated = true; /* Older plugins have no health endpoint. */ })
        .finally(() => { if (this.healthPromise === pending) this.healthPromise = null; });
      this.healthPromise = pending;
    }
    return this.healthPromise;
  }
  setStatus(phase, message) { this.status = { phase, message }; this.emit('update', { type: 'status', data: { ...this.status } }); }
  emitState(value, revision) {
    const state = sanitizeState(value);
    if (Number.isSafeInteger(revision) && revision < this.stateRevision) return;
    if (state) {
      if (Number.isSafeInteger(revision)) this.stateRevision = revision;
      this.state = state; this.emit('update', { type: 'state', data: { ...state }, revision });
    }
  }
  emitSpeech(text, source, requestId) {
    if (typeof text !== 'string') return;
    const now = Date.now();
    for (const [id, timestamp] of this.seenSpeech) if (now - timestamp > 600000) this.seenSpeech.delete(id);
    if (typeof requestId === 'string' && requestId) {
      if (this.seenSpeech.has(requestId)) return;
      this.seenSpeech.set(requestId, now);
      while (this.seenSpeech.size > 128) this.seenSpeech.delete(this.seenSpeech.keys().next().value);
    }
    this.emit('update', { type: 'speak', text: text.slice(0, 12000), source, request_id: requestId, silent: !speechAllowed(this.speechPolicy, source, now) });
  }

  configure(server, token = '') {
    const normalized = normalizeServer(server);
    if (typeof token !== 'string' || token.length > 4096) throw new Error('令牌格式无效。');
    this.stop();
    this.server = normalized; this.token = token; this.state = null; this.stateRevision = -1; this.stateEpoch++; this.seenSpeech.clear(); this.config = { ...DEFAULT_BEHAVIOR }; this.petName = '桌宠'; this.attempt = 0;
    this.requestTimeout = this.defaultRequestTimeout; this.timeoutNegotiated = false; this.healthPromise = null;
    this.emit('update', { type: 'connection_changed', server: this.server });
    this.start();
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect(this.generation);
  }

  stop() {
    this.stopped = true; this.generation++;
    clearTimeout(this.retryTimer); clearInterval(this.heartbeat); clearTimeout(this.helloTimer);
    this.retryTimer = null; this.heartbeat = null;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    const ws = this.ws; this.ws = null;
    if (ws) { try { ws.terminate(); } catch {} }
    this.setStatus('offline', '已断开');
  }

  reconnect() { const server = this.server; const token = this.token; this.configure(server, token); }

  connect(generation) {
    if (this.stopped || generation !== this.generation) return;
    this.setStatus('connecting', this.attempt ? `正在重连（第 ${this.attempt} 次）` : '正在连接插件…');
    const headers = this.token ? { 'X-Pet-Token': this.token } : {};
    let ws;
    try { ws = new this.WebSocketImpl(endpoint(this.server, 'ws', true), { headers, handshakeTimeout: 10000, maxPayload: 256 * 1024 }); }
    catch { this.scheduleReconnect(generation); return; }
    this.ws = ws;
    let authenticated = false;
    let lastReceived = Date.now();
    let denied = false;
    const current = () => !this.stopped && generation === this.generation && this.ws === ws;
    ws.on('open', () => {
      if (!current()) return;
      lastReceived = Date.now();
      this.setStatus('connecting', '连接已建立，正在同步状态…');
      this.helloTimer = setTimeout(() => { if (current() && !authenticated) ws.terminate(); }, 15000);
      this.helloTimer.unref?.();
      this.heartbeat = setInterval(() => {
        if (!current()) return;
        if (Date.now() - lastReceived > 70000) { ws.terminate(); return; }
        try { ws.ping(); } catch { ws.terminate(); }
      }, 25000);
      this.heartbeat.unref?.();
    });
    ws.on('pong', () => { lastReceived = Date.now(); });
    ws.on('message', (raw) => {
      if (!current()) return;
      lastReceived = Date.now();
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!validObject(msg)) return;
      if (msg.type === 'hello') {
        clearTimeout(this.helloTimer);
        authenticated = true; this.attempt = 0;
        this.stateRevision = -1; this.stateEpoch++;
        this.negotiateTimeout(msg.request_timeout_sec);
        this.petName = typeof msg.pet_name === 'string' ? msg.pet_name.slice(0, 128) : '桌宠';
        this.emitState(msg.state, msg.revision);
        this.mergeConfig(msg.config || msg.behavior);
        this.setStatus('online', `已连接 · 插件 ${String(msg.plugin_version || '未知版本')}`);
        const configEpoch = this.configEpoch;
        this.request('GET', 'api/config', undefined, 10000).then(config => { if (current() && configEpoch === this.configEpoch) this.mergeConfig(config); }).catch(error => { if (current()) this.emit('update', { type: 'notice', text: `读取完整设置失败：${error.message}` }); });
      } else if (msg.type === 'state') this.emitState(msg.data, msg.revision);
      else if (msg.type === 'config') this.mergeConfig(msg.data);
      else if (msg.type === 'speak') this.emitSpeech(msg.text, typeof msg.source === 'string' ? msg.source : 'bot', msg.request_id);
    });
    ws.on('unexpected-response', (_request, response) => {
      if (!current()) return;
      if (response.statusCode === 401 || response.statusCode === 403) {
        denied = true; this.setStatus('auth_error', '令牌不匹配，请在连接设置中修改。');
      }
      response.resume(); ws.terminate();
    });
    ws.on('error', () => { /* close schedules a single reconnect; errors never expose the token or URL query. */ });
    ws.on('close', () => {
      if (!current()) return;
      this.ws = null; clearInterval(this.heartbeat); clearTimeout(this.helloTimer); this.heartbeat = null;
      if (!denied) this.scheduleReconnect(generation, authenticated ? '连接中断，正在重试' : '暂时无法连接插件');
    });
  }

  scheduleReconnect(generation, message = '暂时无法连接插件') {
    if (this.stopped || generation !== this.generation || this.retryTimer) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5)) * (0.8 + this.random() * 0.4);
    this.setStatus('retrying', `${message}，${Math.ceil(delay / 1000)} 秒后重连`);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(generation); }, delay);
    this.retryTimer.unref?.();
  }

  mergeConfig(config) {
    if (!validObject(config)) return;
    this.configEpoch++;
    this.negotiateTimeout(config.request_timeout_sec);
    for (const key of ['enable_chatter', 'enable_roam', 'llm_action_reply']) if (typeof config[key] === 'boolean') this.config[key] = config[key];
    if (typeof config.request_timeout_sec === 'number' && Number.isFinite(config.request_timeout_sec) && config.request_timeout_sec > 0) this.config.request_timeout_sec = config.request_timeout_sec;
    for (const key of ['chatter_lines', 'sleepy_lines']) {
      const value = config[key];
      if (typeof value === 'string') this.config[key] = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 200);
      else if (Array.isArray(value) && value.every(line => typeof line === 'string')) this.config[key] = value.slice(0, 200).map(line => line.slice(0, 500));
    }
    for (const [key, min, max] of [['chatter_interval_sec', 5, 86400], ['walk_speed', 0.2, 10], ['sleepy_threshold', 0, 100]]) {
      if (typeof config[key] === 'number' && Number.isFinite(config[key])) this.config[key] = Math.max(min, Math.min(max, config[key]));
    }
    for (const [key, length] of [['pet_name', 128], ['astrbot_persona_id', 128], ['persona', 20000]]) if (typeof config[key] === 'string') this.config[key] = config[key].slice(0, length);
    if (['custom', 'persona', 'default'].includes(config.persona_source)) this.config.persona_source = config.persona_source;
    if (typeof this.config.pet_name === 'string') this.petName = this.config.pet_name.slice(0, 128);
    this.emit('update', { type: 'config', data: { ...this.config } });
  }

  async request(method, route, body, timeout = this.requestTimeout) {
    const requestId = body?.request_id;
    if (this.controllers.size >= 8) throw new PetError('请求较多，请稍候再试。', { code: 'client_busy', request_id: requestId });
    const generation = this.generation;
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout); timer.unref?.();
    try {
      const headers = { Accept: 'application/json' };
      if (this.token) headers['X-Pet-Token'] = this.token;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await this.fetchImpl(endpoint(this.server, route), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, redirect: 'error' });
      let data;
      try { data = await response.json(); } catch (error) { if (error.name === 'AbortError') throw error; throw new PetError(`插件返回了无法解析的响应（HTTP ${response.status}）。`, { code: 'invalid_response', status: response.status, request_id: requestId }); }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new PetError('令牌不匹配，请检查连接设置。', { code: 'unauthorized', status: response.status, request_id: requestId });
        const message = validObject(data) && typeof (data.message || data.error) === 'string' ? (data.message || data.error).slice(0, 300) : `HTTP ${response.status}`;
        throw new PetError(message, { code: typeof data?.code === 'string' ? data.code : 'http_error', status: response.status, request_id: data?.request_id || requestId });
      }
      if (generation !== this.generation) throw new PetError('连接设置已经变化，请重试。', { code: 'connection_changed', request_id: requestId });
      if (!validObject(data)) throw new PetError('插件返回的数据格式不正确。', { code: 'invalid_response', request_id: requestId });
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new PetError('请求已超时或连接已切换；未自动重发，请先确认桌宠状态。', { code: generation === this.generation ? 'request_timeout' : 'connection_changed', request_id: requestId });
      if (error.message === 'fetch failed') throw new PetError('无法访问插件，请检查地址、端口和 AstrBot 是否运行。', { code: 'network_error', request_id: requestId });
      if (requestId && !error.request_id) error.request_id = requestId;
      throw error;
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }

  async getState() { const epoch = this.stateEpoch; const result = await this.request('GET', 'api/state', undefined, 10000); if (epoch === this.stateEpoch) this.emitState(result.state, result.revision); return result; }
  async action(action, requestId = randomUUID()) {
    if (!ACTIONS.has(action)) throw new PetError('不支持的互动。', { code: 'invalid_request', request_id: requestId });
    validateRequestId(requestId);
    const generation = this.generation;
    await this.ensureTimeout().catch(error => { error.request_id = requestId; throw error; });
    if (generation !== this.generation) throw new PetError('连接设置已经变化，请确认后重试。', { code: 'connection_changed', request_id: requestId });
    const epoch = this.stateEpoch;
    const result = await this.request('POST', 'api/action', { action, request_id: requestId }); if (epoch === this.stateEpoch) this.emitState(result.state, result.revision);
    if (result.request_id || this.status.phase !== 'online') this.emitSpeech(result.reply, action, result.request_id);
    return result;
  }
  async chat(text, requestId = randomUUID()) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new PetError('请输入 1–4000 字的聊天内容。', { code: 'invalid_request', request_id: requestId });
    validateRequestId(requestId);
    const generation = this.generation;
    await this.ensureTimeout().catch(error => { error.request_id = requestId; throw error; });
    if (generation !== this.generation) throw new PetError('连接设置已经变化，请确认后重试。', { code: 'connection_changed', request_id: requestId });
    const epoch = this.stateEpoch;
    const result = await this.request('POST', 'api/chat', { text: text.trim(), request_id: requestId }); if (epoch === this.stateEpoch) this.emitState(result.state, result.revision);
    if (result.request_id || this.status.phase !== 'online') this.emitSpeech(result.reply, 'chat', result.request_id);
    return result;
  }
  async requestStatus(requestId, kind = 'chat') {
    validateRequestId(requestId);
    if (!['chat', 'action'].includes(kind)) throw new PetError('请求种类无效。', { code: 'invalid_request', request_id: requestId });
    const epoch = this.stateEpoch;
    const result = await this.request('GET', `api/requests/${encodeURIComponent(requestId)}?kind=${kind}`, undefined, 10000).catch(error => { error.request_id = requestId; throw error; });
    if (result.status === 'completed' && validObject(result.result)) {
      if (epoch === this.stateEpoch) this.emitState(result.result.state, result.result.revision);
      this.emitSpeech(result.result.reply, result.result.action || kind, result.result.request_id || requestId);
    }
    return result;
  }
  async saveConfig(config) {
    const epoch = this.configEpoch;
    const result = await this.request('POST', 'api/config', config, 10000);
    if (epoch === this.configEpoch) this.mergeConfig(result);
    return { ...this.config };
  }
  async personas() { return this.request('GET', 'api/personas', undefined, 10000); }
  async generateLines(kind, count = 8) {
    if (!['chatter', 'sleepy'].includes(kind) || !Number.isInteger(count) || count < 1 || count > 20) throw new Error('台词生成参数无效。');
    return this.request('POST', 'api/generate-lines', { kind, count });
  }
}

module.exports = { DEFAULT_SETTINGS, DEFAULT_BEHAVIOR, ACTIONS, PetError, normalizeServer, endpoint, normalizeSettings, atomicWriteJson, readJson, sanitizeState, PetConnection };
