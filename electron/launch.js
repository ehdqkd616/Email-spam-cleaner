'use strict';
// electron/launch.js — npm run app 진입점
// ELECTRON_RUN_AS_NODE가 설정되어 있으면 Electron이 Node.js처럼 실행되어
// require('electron')이 built-in API를 반환하지 않음 → 반드시 제거 후 실행
const { spawn } = require('child_process');
const path = require('path');

const electronBin = require('electron'); // npm 패키지 → electron.exe 경로 반환 (정상)
const projectRoot = path.join(__dirname, '..');

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE; // 이게 설정되면 Electron이 Node.js 모드로 실행됨

const child = spawn(electronBin, [projectRoot], {
  env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('close', code => process.exit(code ?? 0));
process.on('SIGINT',  () => child.kill());
process.on('SIGTERM', () => child.kill());
