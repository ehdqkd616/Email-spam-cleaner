'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require('electron');
const path  = require('path');
const { spawn } = require('child_process');
const fs    = require('fs');

// 단일 인스턴스 보장
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

const ROOT     = path.join(__dirname, '..');
const APP_PORT = 3005;
const APP_URL  = `http://localhost:${APP_PORT}`;

let win           = null;
let tray          = null;
let serverProcess = null;
let logTimer      = null;
let lastLogPos    = 0;
let logFilePath   = null;
let isQuitting    = false;

// ── 트레이 아이콘 생성 (BGRA 비트맵 원형) ──────────────────────────────
function makeIcon(r, g, b, size = 16) {
  const buf = Buffer.alloc(size * size * 4, 0);
  const cx = (size - 1) / 2, cy = (size - 1) / 2, radius = size / 2 - 1.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) <= radius) {
        const i = (y * size + x) * 4;
        buf[i] = b; buf[i+1] = g; buf[i+2] = r; buf[i+3] = 255;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

const ICO_RUNNING = makeIcon(34, 197, 94);    // 초록 (트레이 상태)
const ICO_STOPPED = makeIcon(107, 114, 128);  // 회색 (트레이 상태)
const ICO_FILE    = path.join(__dirname, 'icon.ico');

// ── 서버 관리 ────────────────────────────────────────────────────────
function running() { return serverProcess !== null && !serverProcess.killed; }

function syncStatus() {
  const r = running();
  win?.webContents.send('status', r);
  tray?.setImage(r ? ICO_RUNNING : ICO_STOPPED);
  tray?.setToolTip(`메일 스팸 정리기 — ${r ? '서버 실행 중 (포트 ${APP_PORT})' : '서버 중지됨'}`);
  buildTrayMenu();
}

function startServer() {
  if (running()) return;
  serverProcess = spawn('node', ['server.js'], {
    cwd:         ROOT,
    stdio:       ['ignore', 'pipe', 'pipe'],
    env:         { ...process.env, NODE_ENV: 'production' },
    windowsHide: true,
  });
  serverProcess.stdout.on('data', d => win?.webContents.send('server-out', d.toString().trimEnd()));
  serverProcess.stderr.on('data', d => win?.webContents.send('server-out', d.toString().trimEnd()));
  serverProcess.on('exit', () => { serverProcess = null; syncStatus(); });
  syncStatus();
}

function stopServer(cb) {
  if (!running()) { cb?.(); return; }
  serverProcess.once('exit', () => cb?.());
  serverProcess.kill();
}

function restartServer() {
  stopServer(() => setTimeout(startServer, 800));
}

// ── 로그 파일 테일링 ──────────────────────────────────────────────────
function todayLog() {
  const d   = new Date();
  const pad = n => String(n).padStart(2, '0');
  return path.join(ROOT, 'logs', `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}.log`);
}

function tailLog() {
  const p = todayLog();
  if (p !== logFilePath) { logFilePath = p; lastLogPos = 0; }
  try {
    const { size } = fs.statSync(p);
    if (size <= lastLogPos) return;
    const fd  = fs.openSync(p, 'r');
    const buf = Buffer.alloc(size - lastLogPos);
    fs.readSync(fd, buf, 0, buf.length, lastLogPos);
    fs.closeSync(fd);
    lastLogPos = size;
    buf.toString('utf8').split('\n').filter(l => l.trim()).forEach(line => {
      try { win?.webContents.send('log-entry', JSON.parse(line)); } catch (_) {}
    });
  } catch (_) {}
}

function loadInitialLogs() {
  const p = todayLog();
  logFilePath = p;
  try {
    const content = fs.readFileSync(p, 'utf8');
    lastLogPos = Buffer.byteLength(content, 'utf8');
    return content.split('\n').filter(l => l.trim()).slice(-300)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ── 트레이 메뉴 ──────────────────────────────────────────────────────
function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '메일 스팸 정리기', enabled: false },
    { type: 'separator' },
    { label: '창 열기',    click: () => { win?.show(); win?.focus(); } },
    { label: '웹앱 열기',  enabled: running(), click: () => shell.openExternal(APP_URL) },
    { type: 'separator' },
    running()
      ? { label: '서버 중지',    click: () => stopServer() }
      : { label: '서버 시작',    click: startServer },
    { label: '서버 재시작', enabled: running(), click: restartServer },
    { type: 'separator' },
    { label: '종료', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

// ── 메인 창 ──────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width:  960, height: 680,
    minWidth: 640, minHeight: 440,
    title: '메일 스팸 정리기',
    icon:  ICO_FILE,
    backgroundColor: '#0f0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'window.html'));
  win.setMenuBarVisibility(false);

  win.on('close', e => { if (!isQuitting) { e.preventDefault(); win.hide(); } });

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('initial-logs', loadInitialLogs());
    syncStatus();
  });
}

// ── 앱 라이프사이클 ──────────────────────────────────────────────────
app.whenReady().then(() => {
  app.setAppUserModelId('com.rudy.mailspamcleaner');

  createWindow();

  tray = new Tray(ICO_STOPPED);
  buildTrayMenu();
  tray.on('double-click', () => { win?.show(); win?.focus(); });

  startServer();
  logTimer = setInterval(tailLog, 1000);
});

app.on('second-instance', () => { win?.show(); win?.focus(); });
app.on('window-all-closed', e => e.preventDefault());
app.on('before-quit', () => {
  isQuitting = true;
  clearInterval(logTimer);
  if (running()) serverProcess.kill();
});

// ── IPC ──────────────────────────────────────────────────────────────
ipcMain.on('start-server',     startServer);
ipcMain.on('stop-server',      () => stopServer());
ipcMain.on('restart-server',   restartServer);
ipcMain.on('open-app',         () => shell.openExternal(APP_URL));
ipcMain.on('open-logs-folder', () => shell.openPath(path.join(ROOT, 'logs')));
