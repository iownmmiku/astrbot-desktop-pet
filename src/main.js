// AstrBot 桌宠桌面端 - Electron 主进程
// 透明无边框、置顶、可鼠标穿透的桌面宠物窗口 + 系统托盘
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require("electron");
const path = require("path");

const SMOKE = process.argv.includes("--smoke");
let win = null;
let tray = null;
let clickThrough = false;

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
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
      // 允许从 file:// 加载本地 Live2D 模型与贴图
      webSecurity: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.loadFile(path.join(__dirname, "index.html"));
  if (SMOKE) win.webContents.on("did-finish-load", () => {
    console.log("SMOKE_OK");
    setTimeout(() => app.exit(0), 1500);
  });
}

function createTray() {
  // 16x16 透明占位图标（也可以换成自己的 logo.png）
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("AstrBot 桌宠");
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开聊天", click: () => win && win.webContents.send("ui:open-chat") },
      { label: "投喂 🍖", click: () => win && win.webContents.send("pet:action", "feed") },
      { label: "摸摸头 🖐", click: () => win && win.webContents.send("pet:action", "play") },
      { label: "洗澡 🛁", click: () => win && win.webContents.send("pet:action", "clean") },
      { label: "睡觉 💤", click: () => win && win.webContents.send("pet:action", "sleep") },
      { type: "separator" },
      {
        label: clickThrough ? "关闭鼠标穿透" : "开启鼠标穿透",
        click: () => toggleClickThrough(),
      },
      {
        label: "更换模型…",
        click: () => win && win.webContents.send("ui:open-settings"),
      },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ])
  );
}

function toggleClickThrough() {
  clickThrough = !clickThrough;
  if (win) win.setIgnoreMouseEvents(clickThrough, { forward: true });
  rebuildTrayMenu();
}

// 渲染层拖拽/漫游移动窗口
ipcMain.on("win:move-by", (_e, dx, dy) => {
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});

ipcMain.on("win:move-to", (_e, x, y) => {
  if (win) win.setPosition(Math.round(x), Math.round(y));
});

ipcMain.handle("win:get-bounds", () => (win ? win.getBounds() : null));
ipcMain.handle("screen:work-area", () => screen.getPrimaryDisplay().workAreaSize);
ipcMain.on("win:toggle-click-through", () => toggleClickThrough());
ipcMain.on("app:quit", () => app.quit());

app.whenReady().then(() => {
  createWindow();
  if (!SMOKE) createTray();
});

app.on("window-all-closed", () => app.quit());
