'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (method, ...args) => {
  const result = await ipcRenderer.invoke(`pet:${method}`, ...args);
  // Error custom properties are discarded by Electron's contextBridge. Reject a
  // plain cloneable record so the renderer retains retry IDs and status codes.
  if (!result?.ok) throw typeof result?.error === 'object' ? result.error : { name: 'PetError', message: result?.error || '操作未完成。', code: 'operation_failed', status: 0 };
  return result.value;
};

contextBridge.exposeInMainWorld('petAPI', Object.freeze({
  snapshot: () => invoke('snapshot'),
  saveSettings: settings => invoke('settings', settings),
  getState: () => invoke('state'),
  reconnect: () => invoke('reconnect'),
  action: (action, requestId) => invoke('action', action, requestId),
  chat: (text, requestId) => invoke('chat', text, requestId),
  requestStatus: (requestId, kind) => invoke('request-status', requestId, kind),
  saveConfig: config => invoke('config', config),
  personas: () => invoke('personas'),
  generateLines: (kind, count) => invoke('generate-lines', kind, count),
  chooseModel: () => invoke('choose-model'),
  defaultModel: () => invoke('default-model'),
  openControl: () => invoke('open-control'),
  resetPosition: () => invoke('reset-position'),
  quit: () => invoke('quit'),
  dragStart: () => invoke('drag-start'),
  dragStop: () => invoke('drag-stop'),
  petActive: () => invoke('pet-active'),
  onUpdate: callback => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, message) => callback(message);
    ipcRenderer.on('pet:update', handler);
    return () => ipcRenderer.removeListener('pet:update', handler);
  }
}));
