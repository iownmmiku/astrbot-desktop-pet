'use strict';

const { normalizeServer, endpoint, sanitizeState } = require('./core');
const MAX_RESPONSE = 256 * 1024;

function diagnosticTarget(input, saved = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('连接测试参数无效。');
  const server = normalizeServer(input.server);
  if ('token' in input && (typeof input.token !== 'string' || input.token.length > 4096)) throw new Error('令牌格式无效。');
  if ('clearToken' in input && typeof input.clearToken !== 'boolean') throw new Error('清除令牌必须是开关值。');
  let token = input.clearToken ? '' : (input.token || '').trim();
  let tokenReused = false;
  if (!input.clearToken && !token && saved.server && server === normalizeServer(saved.server)) {
    if (saved.tokenUnavailable) throw new Error('原令牌无法解密，请重新输入后测试。');
    token = saved.token || ''; tokenReused = Boolean(token);
  }
  return { server, token, tokenReused };
}

async function boundedJson(response, max = MAX_RESPONSE) {
  if (Number(response.headers?.get?.('content-length')) > max) { try { await response.body?.cancel(); } catch {} throw new Error('Response too large'); }
  if (!response.body?.getReader) return response.json();
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength; if (length > max) { await reader.cancel(); throw new Error('Response too large'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}

async function testConnection(input, saved, { fetchImpl = globalThis.fetch, WebSocketImpl = require('ws'), timeout = 8000 } = {}) {
  const { server, token, tokenReused } = diagnosticTarget(input, saved);
  const headers = token ? { 'X-Pet-Token': token, Accept: 'application/json' } : { Accept: 'application/json' };
  const controller = new AbortController();
  let socket;
  const http = (async () => {
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(endpoint(server, 'api/state'), { headers, signal: controller.signal, redirect: 'error' });
      if (response.status === 401 || response.status === 403) return { ok: false, status: response.status, denied: true, message: '服务可达，但令牌不匹配。' };
      if (!response.ok) return { ok: false, status: response.status, message: `HTTP ${response.status}，请检查地址和反向代理路径。` };
      const result = await boundedJson(response);
      if (!sanitizeState(result?.state)) return { ok: false, status: response.status, message: '地址可达，但返回的不是有效桌宠状态。' };
      const version = typeof result.plugin_version === 'string' && /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,64})?$/.test(result.plugin_version) ? result.plugin_version : '未知';
      return { ok: true, status: response.status, version, message: 'HTTP 状态接口正常。' };
    } catch (error) {
      return { ok: false, status: 0, message: error.name === 'AbortError' ? 'HTTP 检测超时，请检查服务、端口和防火墙。' : 'HTTP 无法访问或响应格式错误，请检查地址和服务。' };
    } finally { clearTimeout(timer); controller.abort(); }
  })();
  const websocket = new Promise(resolve => {
    let completed = false;
    const finish = result => {
      if (completed) return; completed = true; clearTimeout(timer);
      try { socket?.terminate(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, status: 0, message: 'WebSocket 检测超时，请检查代理是否转发 /ws。' }), timeout);
    try {
      socket = new WebSocketImpl(endpoint(server, 'ws', true), { headers, handshakeTimeout: timeout, maxPayload: MAX_RESPONSE, followRedirects: false });
      socket.on('message', bytes => {
        try {
          const result = JSON.parse(bytes.toString());
          if (result.type === 'hello' && sanitizeState(result.state)) finish({ ok: true, status: 101, message: 'WebSocket 握手和状态同步正常。' });
        } catch { finish({ ok: false, status: 101, message: 'WebSocket 返回了无效数据。' }); }
      });
      socket.on('unexpected-response', (_request, response) => {
        response.resume();
        finish({ ok: false, status: response.statusCode, denied: [401, 403].includes(response.statusCode), message: [401, 403].includes(response.statusCode) ? 'WebSocket 令牌不匹配。' : `WebSocket 握手失败（HTTP ${response.statusCode}）。` });
      });
      socket.on('error', () => finish({ ok: false, status: 0, message: 'WebSocket 无法连接，请检查地址或代理。' }));
      socket.on('close', () => finish({ ok: false, status: 0, message: 'WebSocket 在同步前关闭。' }));
    } catch { finish({ ok: false, status: 0, message: '无法建立 WebSocket 检测连接。' }); }
  });
  const [httpResult, wsResult] = await Promise.all([http, websocket]);
  const denied = httpResult.denied || wsResult.denied;
  const authenticated = httpResult.ok || wsResult.ok;
  return { server, ok: httpResult.ok && wsResult.ok, tokenReused,
    http: httpResult, websocket: wsResult,
    auth: { ok: denied ? false : authenticated ? true : null, message: denied ? '令牌校验未通过。' : authenticated ? (token ? '当前令牌已通过校验。' : '服务接受无令牌连接。') : '尚未连通服务，无法确认令牌。' },
    message: tokenReused ? '测试使用已保存的令牌，没有保存或切换连接。' : '仅测试当前填写内容，没有保存或切换连接。' };
}

module.exports = { diagnosticTarget, boundedJson, testConnection };
