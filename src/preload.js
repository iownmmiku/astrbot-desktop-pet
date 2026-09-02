const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petAPI", {
  moveBy: (dx, dy) => ipcRenderer.send("win:move-by", dx, dy),
  moveTo: (x, y) => ipcRenderer.send("win:move-to", x, y),
  getBounds: () => ipcRenderer.invoke("win:get-bounds"),
  getWorkArea: () => ipcRenderer.invoke("screen:work-area"),
  toggleClickThrough: () => ipcRenderer.send("win:toggle-click-through"),
  quit: () => ipcRenderer.send("app:quit"),
  onOpenChat: (fn) => ipcRenderer.on("ui:open-chat", fn),
  onOpenSettings: (fn) => ipcRenderer.on("ui:open-settings", fn),
  onAction: (fn) => ipcRenderer.on("pet:action", (_e, action) => fn(action)),
});
