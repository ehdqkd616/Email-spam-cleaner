const fs   = require('fs');
const path = require('path');
const chalk = require('chalk');

const LOG_DIR = path.join(__dirname, '..', 'logs');

// ── 내부 유틸 ──────────────────────────────────────────────────────
function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function todayFile() {
  const d   = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return path.join(LOG_DIR, `${ymd}.log`);
}

function nowTs() {
  const d   = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ── 인메모리 링 버퍼 ───────────────────────────────────────────────
const buffer = [];
const MAX_BUF = 500;

// ── 핵심 기록 함수 ─────────────────────────────────────────────────
function record(level, category, message) {
  const entry = { ts: nowTs(), level, category, message };

  buffer.push(entry);
  if (buffer.length > MAX_BUF) buffer.shift();

  ensureDir();
  try {
    fs.appendFileSync(todayFile(), JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {}

  return entry;
}

const LEVEL_COLOR = {
  INFO:    chalk.blue,
  SUCCESS: chalk.green,
  WARN:    chalk.yellow,
  ERROR:   chalk.red,
};

const CAT_COLOR = {
  AUTH:       chalk.magenta,
  SCAN:       chalk.cyan,
  CATEGORIZE: chalk.blue,
  CLEAN:      chalk.yellow,
  SPAM:       chalk.red,
  FILTER:     chalk.green,
  BLOCK:      chalk.red,
  SYSTEM:     chalk.gray,
};

/**
 * @param {'INFO'|'SUCCESS'|'WARN'|'ERROR'} level
 * @param {string} category
 * @param {string} message
 * @param {boolean} silent  true = 파일만 기록 (CLI 스피너 간섭 방지)
 */
function write(level, category, message, silent = false) {
  const e = record(level, category, message);
  if (!silent) {
    const lCol = LEVEL_COLOR[level]    || chalk.white;
    const cCol = CAT_COLOR[category]   || chalk.cyan;
    const levelStr = `[${level}]`.padEnd(9);
    const catStr   = `[${category}]`.padEnd(12);
    console.log(`${chalk.gray(`[${e.ts}]`)} ${lCol(levelStr)} ${cCol(catStr)} ${message}`);
  }
}

// ── 로그 파일 읽기 (API용) ─────────────────────────────────────────
function readLogFile(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const d   = date || new Date();
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const file = path.join(LOG_DIR, `${ymd}.log`);
  if (!fs.existsSync(file)) return [];

  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    })
    .filter(Boolean);
}

function listLogDates() {
  ensureDir();
  return fs
    .readdirSync(LOG_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .map((f) => f.replace('.log', ''))
    .sort()
    .reverse();
}

// ── 공개 API ───────────────────────────────────────────────────────
module.exports = {
  info:    (cat, msg, silent) => write('INFO',    cat, msg, silent),
  success: (cat, msg, silent) => write('SUCCESS', cat, msg, silent),
  warn:    (cat, msg, silent) => write('WARN',    cat, msg, silent),
  error:   (cat, msg, silent) => write('ERROR',   cat, msg, silent),

  getBuffer:   (n = 200)  => buffer.slice(-n),
  readLogFile,
  listLogDates,
};
