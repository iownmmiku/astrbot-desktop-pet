const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petAPI", {
  // 窗口控制
  moveBy: (dx, dy) => ipcRenderer.send("win:move-by", dx, dy),
  moveTo: (x, y) => ipcRenderer.send("win:move-to", x, y),
  getBounds: () => ipcRenderer.invoke("win:get-bounds"),
  getWorkArea: () => ipcRenderer.invoke("screen:work-area"),
  toggleClickThrough: () => ipcRenderer.send("win:toggle-click-through"),
  quit: () => ipcRenderer.send("app:quit"),
  openPanel: () => ipcRenderer.send("panel:open"),
  pickModel: () => ipcRenderer.invoke("dialog:pick-model"),
  getDataDir: () => ipcRenderer.invoke("app:data-dir"),
  getDefaultModel: () => ipcRenderer.invoke("app:default-model"),
  // 设置（主进程持久化）
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (s) => ipcRenderer.invoke("settings:set", s),
  // 事件
  onOpenChat: (fn) => ipcRenderer.on("ui:open-chat", fn),
  onOpenSettings: (fn) => ipcRenderer.on("ui:open-settings", fn),
  onAction: (fn) => ipcRenderer.on("pet:action", (_e, action) => fn(action)),
  onSettingsChanged: (fn) => ipcRenderer.on("settings:changed", (_e, s) => fn(s)),
});
