'use strict';

function loginTarget({ isPackaged, platform = process.platform, executable = process.execPath, portableExecutable = process.env.PORTABLE_EXECUTABLE_FILE, isolated = Boolean(process.env.PET_DATA_DIR) }) {
  if (platform !== 'win32') return { supported: false, message: '当前仅 Windows 发行版支持开机启动。' };
  if (!isPackaged || isolated) return { supported: false, message: '源码运行或独立测试环境不设置系统开机启动。' };
  return { supported: true, path: portableExecutable || executable, args: ['--background'], name: 'AstrBotDesktopPet' };
}
class StartupController {
  constructor(app, options = {}) { this.app = app; this.target = loginTarget({ isPackaged: app.isPackaged, ...options }); }
  status() {
    if (!this.target.supported) return { ...this.target, enabled: false };
    try {
      const current = this.app.getLoginItemSettings(this.target);
      return { supported: true, enabled: Boolean(current.openAtLogin && current.executableWillLaunchAtLogin !== false), message: '开机启动使用程序所在位置；移动便携 EXE 后请重新保存此设置。' };
    } catch { return { supported: false, enabled: false, message: '无法读取系统启动项；其他启动设置仍可使用。' }; }
  }
  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('开机启动必须是开关值。');
    if (!this.target.supported) { if (enabled) throw new Error(this.target.message); return; }
    this.app.setLoginItemSettings({ ...this.target, openAtLogin: enabled });
    const after = this.status();
    if (!after.supported || after.enabled !== enabled) throw new Error('系统没有应用开机启动设置，请检查 Windows 启动应用设置。');
  }
}
module.exports = { loginTarget, StartupController };
