// electron/preload.js — Runs in the renderer before page scripts.
// Exposes only what the web app needs; everything else is blocked
// by contextIsolation: true.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  // Expose the platform so the app can show "desktop" UI hints
  platform: process.platform,
  // App version from package.json
  version: process.env.npm_package_version ?? '0.1.0',
});
