// electron/main.js — Desktop app entry point
//
// In dev:  loads the Expo web dev server at http://127.0.0.1:8081
// In prod: serves the static export from dist/ via a file: URL with
//          a custom protocol so expo-router path-based routing works.
//
// Usage:
//   Dev:   npm run electron:dev   (starts expo web + electron together)
//   Build: npm run electron:build (exports web, then packages Electron)

const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = process.env.NODE_ENV !== 'production';
const DEV_URL = 'http://127.0.0.1:8081';
const DIST_DIR = path.join(__dirname, '..', 'dist');

// Register fingrr:// protocol to serve the static export from dist/
// This lets expo-router's path-based routing work without a local HTTP server.
if (!isDev) {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'fingrr', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    minWidth: 400,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow navigator.mediaDevices for WebRTC voice/video
      webSecurity: true,
    },
    show: false,
  });

  win.once('ready-to-show', () => win.show());

  if (isDev) {
    win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadURL('fingrr://app/');
  }

  // Handle external links — open in system browser, not Electron
  win.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  if (!isDev) {
    // Serve dist/ under fingrr://app/
    protocol.handle('fingrr', (request) => {
      let urlPath = new URL(request.url).pathname;
      // Trailing slash or path-based routing → serve index.html
      if (urlPath === '/' || !path.extname(urlPath)) {
        urlPath = '/index.html';
      }
      const filePath = path.join(DIST_DIR, urlPath);
      if (fs.existsSync(filePath)) {
        return net.fetch('file://' + filePath);
      }
      // Fallback to index.html for SPA routing
      return net.fetch('file://' + path.join(DIST_DIR, 'index.html'));
    });
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
