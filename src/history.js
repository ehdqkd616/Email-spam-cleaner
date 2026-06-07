const fs   = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '..', 'logs', 'categorize-history.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (_) { return []; }
}

function save(history) {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
}

/**
 * 분류 실행 결과를 저장
 * @param {string} provider  'gmail' | 'naver' | 'nate' | 'cau'
 * @param {Array<{key, name, count}>} categories  분류된 카테고리별 건수
 */
function addRecord(provider, categories) {
  const history = load();
  const total   = categories.reduce((s, c) => s + c.count, 0);
  history.unshift({ ts: new Date().toISOString(), provider, total, categories });
  save(history.slice(0, 200));
}

/**
 * 분류 내역 조회
 * @param {number} limit  최대 반환 건수 (기본 50)
 * @param {string} provider  특정 프로바이더 필터 (선택)
 */
function getHistory(limit = 50, provider = '') {
  let records = load();
  if (provider) records = records.filter((r) => r.provider === provider);
  return records.slice(0, limit);
}

module.exports = { addRecord, getHistory };
