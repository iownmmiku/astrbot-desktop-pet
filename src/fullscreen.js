'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

class FullscreenMonitor {
  constructor({ onChange = () => {}, spawnImpl = spawn, platform = process.platform, parentPid = process.pid, systemRoot = process.env.SystemRoot || 'C:\\Windows', watchdogMs = 15000 } = {}) {
    this.onChange = onChange; this.spawn = spawnImpl; this.platform = platform; this.parentPid = parentPid;
    this.systemRoot = systemRoot; this.watchdogMs = watchdogMs; this.child = null; this.watchdog = null;
    this.state = { supported: platform === 'win32', ready: false, active: false, message: platform === 'win32' ? '全屏时自动安静，可随时关闭。' : '当前系统暂不支持自动检测全屏，可使用手动免打扰。' };
  }
  status() { return { ...this.state }; }
  update(patch) {
    const next = { ...this.state, ...patch };
    if (JSON.stringify(next) !== JSON.stringify(this.state)) { this.state = next; this.onChange(this.status()); }
  }
  start() {
    if (this.child || this.platform !== 'win32') return;
    if (!Number.isSafeInteger(this.parentPid) || this.parentPid <= 0) throw new Error('Invalid owner process.');
    let child;
    try {
      const source = fs.readFileSync(path.join(__dirname, 'native/fullscreen-windows.ps1'), 'utf8').replace('__PARENT_PID__', String(this.parentPid));
      const command = Buffer.from(source, 'utf16le').toString('base64');
      child = this.spawn(path.join(this.systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { this.fail(); return; }
    this.child = child; let buffered = '';
    const arm = () => { clearTimeout(this.watchdog); this.watchdog = setTimeout(() => { if (this.child === child) { this.stop(); this.fail(); } }, this.watchdogMs); this.watchdog.unref?.(); };
    arm(); child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffered += chunk;
      if (buffered.length > 8192) { this.stop(); this.fail(); return; }
      const lines = buffered.split(/\r?\n/); buffered = lines.pop();
      for (const line of lines) {
        let value; try { value = JSON.parse(line); } catch { continue; }
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        if (value.error) { this.stop(); this.fail(); return; }
        if (value.owned === true) { arm(); this.update({ ready: true, supported: true }); }
        if (typeof value.active === 'boolean') { arm(); this.update({ supported: true, ready: true, active: value.active, message: value.active ? '检测到全屏或演示，桌宠暂时安静。' : '全屏时自动安静，可随时关闭。' }); }
      }
    });
    child.stderr.resume();
    child.on('error', () => { if (this.child === child) { this.stop(); this.fail(); } });
    child.on('exit', () => { if (this.child === child) { this.child = null; clearTimeout(this.watchdog); this.fail(); } });
  }
  fail() { this.update({ supported: false, ready: false, active: false, message: '全屏检测暂不可用；手动免打扰仍可使用。' }); }
  stop() { clearTimeout(this.watchdog); this.watchdog = null; const child = this.child; this.child = null; if (child) { try { child.kill(); } catch {} } this.update({ active: false }); }
}
function quickChatBounds(pet, area) {
  const width = Math.min(420, area.width), height = Math.min(470, area.height);
  let x = pet.x - width - 12;
  if (x < area.x) x = pet.x + pet.width + 12;
  return { x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, x))), y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, pet.y + pet.height - height))), width, height };
}
module.exports = { FullscreenMonitor, quickChatBounds };
