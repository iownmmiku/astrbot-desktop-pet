'use strict';
// Renders build/icon.svg to the PNG icons used by the installer, the EXE and
// the app windows. Run with: npx electron scripts/render-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outputs = [
  { size: 512, file: path.join(root, 'build', 'icon.png') },
  { size: 256, file: path.join(root, 'src', 'assets', 'icon.png') }
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<!doctype html><body></body>');
  const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');
  for (const { size, file } of outputs) {
    const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = ${size};
        canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size}); resolve(canvas.toDataURL('image/png')); };
      image.onerror = reject;
      image.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
    })`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`${size}x${size} -> ${path.relative(root, file)}`);
  }
  app.quit();
});
