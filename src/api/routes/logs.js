const express = require('express');
const router  = express.Router();
const logger  = require('../../logger');

// ── GET /api/logs ──────────────────────────────────────────────────
// 쿼리 파라미터:
//   date     = YYYY-MM-DD  (기본: 오늘)
//   limit    = 숫자        (기본: 200)
//   level    = INFO|SUCCESS|WARN|ERROR  (기본: 전체)
//   category = AUTH|SCAN|CATEGORIZE|CLEAN|SPAM|FILTER|BLOCK|SYSTEM
router.get('/', (req, res) => {
  const { date, limit = 200, level, category } = req.query;

  let entries;
  if (date) {
    const [y, m, d] = date.split('-').map(Number);
    entries = logger.readLogFile(new Date(y, m - 1, d));
  } else {
    // 오늘 파일 우선, 없으면 인메모리 버퍼
    const fromFile = logger.readLogFile();
    entries = fromFile.length ? fromFile : logger.getBuffer(Number(limit));
  }

  if (level)    entries = entries.filter((e) => e.level    === level.toUpperCase());
  if (category) entries = entries.filter((e) => e.category === category.toUpperCase());

  entries = entries.slice(-Number(limit));

  res.json({ entries, total: entries.length });
});

// ── GET /api/logs/dates ────────────────────────────────────────────
// 로그 파일이 존재하는 날짜 목록 반환
router.get('/dates', (_req, res) => {
  res.json({ dates: logger.listLogDates() });
});

module.exports = router;
