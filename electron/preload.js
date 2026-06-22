'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 서버 제어
  startServer:     () => ipcRenderer.send('start-server'),
  stopServer:      () => ipcRenderer.send('stop-server'),
  restartServer:   () => ipcRenderer.send('restart-server'),
  openApp:         () => ipcRenderer.send('open-app'),
  openLogsFolder:  () => ipcRenderer.send('open-logs-folder'),

  // 이벤트 수신 (이전 리스너 제거 후 등록)
  onStatus:       cb => { ipcRenderer.removeAllListeners('status');       ipcRenderer.on('status',       (_, v) => cb(v)); },
  onInitialLogs:  cb => { ipcRenderer.removeAllListeners('initial-logs'); ipcRenderer.on('initial-logs', (_, v) => cb(v)); },
  onLogEntry:     cb => { ipcRenderer.removeAllListeners('log-entry');    ipcRenderer.on('log-entry',    (_, v) => cb(v)); },
  onServerOut:    cb => { ipcRenderer.removeAllListeners('server-out');   ipcRenderer.on('server-out',   (_, v) => cb(v)); },
});
