// AstrBot 桌宠桌面端 - Electron 主进程
// 完整桌面应用：控制面板窗口 + 桌宠窗口（透明无边框置顶）
// 关闭控制面板时询问「最小化到托盘 / 退出程序」；未彻底退出前桌宠一直存在
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

const SMOKE = process.argv.includes("--smoke");
let petWin = null;    // 桌宠窗口
let panelWin = null;  // 控制面板窗口
let tray = null;
let clickThrough = false;
let alwaysOnTop = true;
let isQuitting = false;
let closeAction = null; // 记住的关闭动作: "minimize" | "quit" | null(每次询问)

// ---------------- 数据目录 ----------------
// 用户数据（设置、解压的模型包）存到系统用户目录（%APPDATA%），升级/替换 exe 不会丢失；
// exe 旁的 data/models/ 只放随包发布的默认模型（只读资源）
const RES_DIR = app.isPackaged ? path.dirname(app.getPath("exe")) : path.join(__dirname, "..");

function userDir() {
  const d = app.getPath("userData");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
ipcMain.handle("app:data-dir", () => userDir());

/** 默认模型（Haru）的 file URL：打包后在 exe 旁 data/models/Haru，开发时在项目 models/Haru */
function defaultModelUrl() {
  const p = app.isPackaged
    ? path.join(RES_DIR, "data", "models", "Haru", "Haru.model3.json")
    : path.join(RES_DIR, "models", "Haru", "Haru.model3.json");
  return toFileUrl(p);
}
ipcMain.handle("app:default-model", () => defaultModelUrl());

// ---------------- 设置持久化（userData/settings.json） ----------------

function settingsPath() {
  return path.join(userDir(), "settings.json");
}
function loadSettings() {
  const current = settingsPath();
  try {
    return JSON.parse(fs.readFileSync(current, "utf-8"));
  } catch {
    // 兼容 v0.4.0/v0.4.1：旧设置在 exe 旁 data/settings.json，首次启动自动迁移
    const legacy = path.join(RES_DIR, "data", "settings.json");
    if (legacy !== current) {
      try {
        const data = JSON.parse(fs.readFileSync(legacy, "utf-8"));
        saveSettings(data);
        return data;
      } catch (_) {}
    }
    return {};
  }
}
function saveSettings(s) {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2), "utf-8");
  } catch (e) {
    console.error("设置保存失败", e);
  }
}

// ---------------- 桌宠窗口 ----------------

function createPetWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  petWin = new BrowserWindow({
    width: 320,
    height: 360,
    x: Math.round(width * 0.7),
    y: Math.round(height - 380),
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false, // 允许加载本地/远程 Live2D 模型
    },
  });
  applyAlwaysOnTop(alwaysOnTop);
  // 未彻底退出前，桌宠窗口不允许被关闭（Alt+F4 也拦截）
  petWin.on("close", (e) => {
    if (!isQuitting) e.preventDefault();
  });
  petWin.loadFile(path.join(__dirname, "index.html"));
  if (SMOKE) petWin.webContents.on("did-finish-load", () => {
    console.log("SMOKE_OK");
    setTimeout(() => app.exit(0), 1500);
  });
}

// ---------------- 控制面板窗口 ----------------

function createPanelWindow() {
  if (panelWin) {
    panelWin.show();
    panelWin.focus();
    return;
  }
  panelWin = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 760,
    minHeight: 560,
    title: "AstrBot 桌宠 - 控制面板",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false, // 允许面板直连插件 API（含远程服务器）
    },
  });
  panelWin.loadFile(path.join(__dirname, "panel.html"));

  // 关闭时：询问最小化到托盘还是退出程序
  panelWin.on("close", async (e) => {
    if (isQuitting) return;
    if (closeAction === "minimize") {
      e.preventDefault();
      panelWin.hide();
      return;
    }
    if (closeAction === "quit") {
      // 桌宠窗口仍然存在，单纯放行 panel close 不会触发 window-all-closed；必须主动退出
      e.preventDefault();
      quitApp();
      return;
    }

    e.preventDefault();
    const { response, checkboxChecked } = await dialog.showMessageBox(panelWin, {
      type: "question",
      buttons: ["最小化到托盘", "退出程序", "取消"],
      defaultId: 0,
      cancelId: 2,
      title: "关闭",
      message: "要最小化到托盘还是退出程序？",
      detail: "最小化后桌宠会继续留在桌面上；只有彻底退出程序，桌宠才会消失。",
      checkboxLabel: "记住我的选择",
      checkboxChecked: false,
    });
    if (checkboxChecked && response !== 2) {
      closeAction = response === 0 ? "minimize" : "quit";
    }
    if (response === 0) {
      panelWin.hide();
    } else if (response === 1) {
      quitApp();
    }
  });
  panelWin.on("closed", () => (panelWin = null));
}

// ---------------- 托盘 ----------------

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("AstrBot 桌宠");
  tray.on("double-click", () => createPanelWindow());
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开控制面板", click: () => createPanelWindow() },
      { type: "separator" },
      { label: "打开聊天", click: () => petWin && petWin.webContents.send("ui:open-chat") },
      { label: "投喂 🍖", click: () => petWin && petWin.webContents.send("pet:action", "feed") },
      { label: "摸摸头 🖐", click: () => petWin && petWin.webContents.send("pet:action", "play") },
      { label: "洗澡 🛁", click: () => petWin && petWin.webContents.send("pet:action", "clean") },
      { label: "睡觉 💤", click: () => petWin && petWin.webContents.send("pet:action", "sleep") },
      { type: "separator" },
      {
        label: "置顶显示", type: "checkbox", checked: alwaysOnTop,
        click: (item) => {
          applyAlwaysOnTop(item.checked);
          const s = loadSettings();
          s.alwaysOnTop = item.checked;
          saveSettings(s);
          if (petWin) petWin.webContents.send("settings:changed", s);
        },
      },
      { label: clickThrough ? "关闭鼠标穿透" : "开启鼠标穿透", click: () => toggleClickThrough() },
      { type: "separator" },
      { label: "退出程序", click: () => quitApp() },
    ])
  );
}

function applyAlwaysOnTop(on) {
  alwaysOnTop = !!on;
  if (petWin) {
    petWin.setAlwaysOnTop(alwaysOnTop);
    if (alwaysOnTop) petWin.setAlwaysOnTop(true, "screen-saver");
  }
  rebuildTrayMenu();
  return alwaysOnTop;
}

function toggleClickThrough() {
  clickThrough = !clickThrough;
  if (petWin) petWin.setIgnoreMouseEvents(clickThrough, { forward: true });
  rebuildTrayMenu();
  return clickThrough;
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

// ---------------- IPC ----------------

ipcMain.on("win:move-by", (_e, dx, dy) => {
  if (!petWin) return;
  const [x, y] = petWin.getPosition();
  petWin.setPosition(Math.round(x + dx), Math.round(y + dy));
});
ipcMain.on("win:move-to", (_e, x, y) => {
  if (petWin) petWin.setPosition(Math.round(x), Math.round(y));
});
ipcMain.handle("win:get-bounds", () => (petWin ? petWin.getBounds() : null));
ipcMain.handle("screen:work-area", () => screen.getPrimaryDisplay().workAreaSize);
ipcMain.on("win:toggle-click-through", () => toggleClickThrough());
ipcMain.on("win:set-always-on-top", (_e, on) => applyAlwaysOnTop(on));
ipcMain.on("app:quit", () => quitApp());
ipcMain.on("panel:open", () => createPanelWindow());

// 模型文件选择：支持 .model3.json 直接选用，或 .wpk/.zip 解压后自动定位模型
ipcMain.handle("dialog:pick-model", async () => {
  const win = panelWin || petWin;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "选择 Live2D 模型或模型包",
    filters: [
      { name: "Live2D 模型 / 模型包", extensions: ["model3.json", "model.json", "wpk", "zip"] },
      { name: "所有文件", extensions: ["*"] },
    ],
    properties: ["openFile"],
  });
  if (canceled || !filePaths.length) return { canceled: true };
  let picked = filePaths[0];

  // wpk（VPet 创意工坊模型包）与 zip 都是压缩包：解压到 userData/models/<名称>/
  if (/\.(wpk|zip)$/i.test(picked)) {
    try {
      const AdmZip = require("adm-zip");
      const name = path.basename(picked).replace(/\.(wpk|zip)$/i, "");
      const dest = path.join(userDir(), "models", name);
      fs.mkdirSync(dest, { recursive: true });
      new AdmZip(picked).extractAllTo(dest, true);
      const found = findModel3(dest);
      if (!found) return { error: "压缩包里没有找到 .model3.json 模型文件" };
      picked = found;
    } catch (e) {
      return { error: "模型包解压失败：" + e.message };
    }
  }
  return { modelPath: toFileUrl(picked) };
});

function findModel3(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = findModel3(p);
      if (r) return r;
    } else if (/\.model3\.json$/i.test(e.name)) {
      return p;
    }
  }
  return null;
}

function toFileUrl(p) {
  // encodeURI：路径含中文/空格时 fetch 才能正确加载
  return "file:///" + encodeURI(p.replace(/\\/g, "/"));
}

// 设置读写：主进程统一持久化，变更后推给桌宠窗口
ipcMain.handle("settings:get", () => loadSettings());
ipcMain.handle("settings:set", (_e, s) => {
  saveSettings(s || {});
  if (s && s.alwaysOnTop !== undefined) applyAlwaysOnTop(!!s.alwaysOnTop);
  if (petWin) petWin.webContents.send("settings:changed", loadSettings());
  return true;
});

app.whenReady().then(() => {
  alwaysOnTop = loadSettings().alwaysOnTop !== false; // 默认置顶
  createPetWindow();
  if (!SMOKE) {
    createTray();
    createPanelWindow(); // 启动时显示控制面板
  }
});

// 所有窗口关闭时才真正退出（桌宠窗口在 isQuitting 前不可关闭）
app.on("window-all-closed", () => {
  if (isQuitting || SMOKE) app.quit();
});
app.on("before-quit", () => (isQuitting = true));
