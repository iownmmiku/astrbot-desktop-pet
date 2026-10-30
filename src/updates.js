'use strict';

const { boundedJson } = require('./diagnostics');
const PROJECTS = Object.freeze({ desktop: 'iownmmiku/astrbot-desktop-pet', plugin: 'iownmmiku/astrbot_plugin_desktop_pet' });
function parseVersion(value) {
  const match = typeof value === 'string' && /^v?(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?$/.exec(value.trim());
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current); if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function releaseUrl(kind, candidate) {
  if (!Object.hasOwn(PROJECTS, kind)) throw new Error('未知的更新项目。');
  const repo = PROJECTS[kind];
  const fallback = `https://github.com/${repo}/releases/latest`;
  if (!candidate) return fallback;
  const url = new URL(candidate);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(`/${repo}/releases/tag/`) || url.pathname.slice(`/${repo}/releases/tag/`.length).includes('/')) throw new Error('发行版链接不属于当前项目。');
  return url.toString();
}
class UpdateChecker {
  constructor({ fetchImpl = globalThis.fetch, timeout = 10000, now = Date.now } = {}) {
    this.fetch = fetchImpl; this.timeout = timeout; this.now = now; this.pending = null; this.result = null;
  }
  async project(kind, current) {
    const entry = { current: current || '未知', latest: null, available: false, url: releaseUrl(kind), notes: '', error: '' };
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await this.fetch(`https://api.github.com/repos/${PROJECTS[kind]}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: controller.signal, redirect: 'error'
      });
      if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'GitHub 请求限额已到，请稍后再试。' : response.status === 404 ? '暂时没有正式发行版。' : `更新服务返回 HTTP ${response.status}。`);
      const value = await boundedJson(response, 512 * 1024);
      if (value?.draft !== false || value?.prerelease !== false || !parseVersion(value?.tag_name)) throw new Error('更新服务返回了无效版本信息。');
      entry.url = releaseUrl(kind, value.html_url);
      entry.latest = value.tag_name.replace(/^v/, ''); entry.available = isNewer(entry.latest, current);
      entry.notes = typeof value.body === 'string' ? value.body.slice(0, 16000) : '';
      if (!parseVersion(current)) entry.message = '尚未获得当前插件版本，连接后可再次检查。';
    } catch (error) { entry.error = error.name === 'AbortError' ? '检查更新超时，请检查网络后重试。' : error.message.startsWith('更新') || error.message.startsWith('GitHub') || error.message.startsWith('暂时') || error.message.startsWith('发行版') ? error.message : '无法检查更新，请检查网络后重试。'; }
    finally { clearTimeout(timer); controller.abort(); }
    return entry;
  }
  check({ desktop, plugin }) {
    if (this.pending) return this.pending;
    const pending = Promise.all([this.project('desktop', desktop), this.project('plugin', plugin)]).then(([a, b]) => {
      this.result = { checkedAt: this.now(), desktop: a, plugin: b, compatibility: { minimumPlugin: '0.5.0', ok: parseVersion(plugin) ? !isNewer('0.5.0', plugin) : null } };
      return this.result;
    }).finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending; return pending;
  }
  url(kind) { return releaseUrl(kind, this.result?.[kind]?.url?.endsWith('/latest') ? undefined : this.result?.[kind]?.url); }
}
module.exports = { PROJECTS, parseVersion, isNewer, releaseUrl, UpdateChecker };
