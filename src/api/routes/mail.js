const express = require('express');
const router  = express.Router();
const logger  = require('../../logger');
const history = require('../../history');
const { matchCategory } = require('../../matcher');

// ── 클라이언트 생성 헬퍼 ───────────────────────────────────────────
async function buildClient(provider, sessionData) {
  logger.info('SYSTEM', `[${provider}] 클라이언트 연결 중...`);
  let client;
  switch (provider) {
    case 'gmail': {
      const { getAuthClient } = require('../../gmail/auth.cli');
      const { GmailClient }   = require('../../gmail/client');
      const auth = await getAuthClient();
      client = new GmailClient(auth);
      break;
    }
    case 'naver': {
      const { NaverClient } = require('../../naver/client');
      client = new NaverClient({ user: sessionData.user, password: sessionData.password });
      await client.connect();
      break;
    }
    case 'nate': {
      const { NateClient } = require('../../nate/client');
      client = new NateClient({ user: sessionData.user, password: sessionData.password });
      await client.connect();
      break;
    }
    case 'cau': {
      const { CauGraphClient } = require('../../cau/client');
      client = new CauGraphClient(sessionData.accessToken);
      break;
    }
    default:
      throw new Error(`지원하지 않는 프로바이더: ${provider}`);
  }
  logger.info('SYSTEM', `[${provider}] 클라이언트 연결 완료`);
  return client;
}

function requireAuth(req, res, next) {
  const { provider } = req.params;
  if (!req.session.providers?.[provider])
    return res.status(401).json({ error: `${provider} 미연결` });
  next();
}

// ── GET /api/mail/history ─────────────────────────────────────────
router.get('/history', (req, res) => {
  const { limit = 50, provider = '' } = req.query;
  res.json(history.getHistory(Number(limit), provider));
});

// ── GET /api/mail/:provider/profile ───────────────────────────────
router.get('/:provider/profile', requireAuth, async (req, res) => {
  const { provider } = req.params;
  try {
    const client = await buildClient(provider, req.session.providers[provider]);
    const profile = await client.getProfile();
    if (client.disconnect) await client.disconnect().catch(() => {});
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/mail/:provider/scan  (SSE) ──────────────────────────
router.get('/:provider/scan', requireAuth, async (req, res) => {
  const { provider } = req.params;
  const { keys = '', readFilter = '' } = req.query;
  const selectedKeys = keys.split(',').filter(Boolean);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  function log(level, msg)   { logger[level]('SCAN', msg); send('log', { message: msg, level }); }

  let client;
  try {
    client = await buildClient(provider, req.session.providers[provider]);
    const { QUERIES, buildCriteria } = require(`../../${provider}/queries`);

    const readLabel = readFilter === 'is:unread' ? '미열람' : readFilter === 'is:read' ? '열람' : '전체';
    logger.info('SCAN', `[${provider}] 스캔 시작 — 카테고리 ${selectedKeys.length}개 | 필터: ${readLabel}`);
    send('start', { total: selectedKeys.length });

    const results = {};
    for (const key of selectedKeys) {
      const def = QUERIES[key];
      if (!def) continue;

      logger.info('SCAN', `  [${def.name}] 검색 중...`);
      send('progress', { key, name: def.name, status: 'scanning' });

      const criteria = buildCriteria(key, readFilter);
      const messages = await client.searchInFolder(def.folder, criteria);

      const samples = messages.length
        ? await client.getMetadata(messages.slice(0, 10).map((m) => m.id))
        : [];

      results[key] = {
        name: def.name,
        description: def.description,
        count: messages.length,
        ids: messages.map((m) => m.id),
        samples: samples.map((m) => ({
          id: m.id,
          subject: m.payload?.headers?.find((h) => h.name === 'Subject')?.value || '',
          from:    m.payload?.headers?.find((h) => h.name === 'From')?.value || '',
          date:    m.payload?.headers?.find((h) => h.name === 'Date')?.value || '',
        })),
      };

      if (messages.length > 0) {
        logger.success('SCAN', `  [${def.name}] ${messages.length}개 발견`);
      } else {
        logger.info('SCAN', `  [${def.name}] 해당 메일 없음`);
      }
      send('progress', { key, name: def.name, status: 'done', count: messages.length });
    }

    const total = Object.values(results).reduce((s, r) => s + r.count, 0);
    logger.success('SCAN', `[${provider}] 스캔 완료 — 총 ${total}개 발견`);
    send('complete', { results });
  } catch (err) {
    logger.error('SCAN', `[${provider}] 스캔 오류: ${err.message}`);
    send('error', { message: err.message });
  } finally {
    if (client?.disconnect) await client.disconnect().catch(() => {});
    res.end();
  }
});

// ── POST /api/mail/:provider/execute ─────────────────────────────
router.post('/:provider/execute', requireAuth, async (req, res) => {
  const { provider } = req.params;
  const { ids = [], action } = req.body;
  if (!['trash', 'delete', 'spam'].includes(action))
    return res.status(400).json({ error: '유효하지 않은 액션' });
  if (!ids.length) return res.json({ count: 0 });

  const labels = { trash: '휴지통 이동', delete: '영구 삭제', spam: '스팸 처리' };
  logger.info('CLEAN', `[${provider}] ${labels[action]} 시작 — ${ids.length}개`);

  let client;
  try {
    client = await buildClient(provider, req.session.providers[provider]);
    let count = 0;
    if (action === 'trash')  count = await client.trashMessages(ids);
    if (action === 'delete') count = await client.deleteMessages(ids);
    if (action === 'spam')   count = await client.markAsSpam(ids);
    logger.success('CLEAN', `[${provider}] ${labels[action]} 완료 — ${count}개 처리됨`);
    res.json({ success: true, count });
  } catch (err) {
    logger.error('CLEAN', `[${provider}] ${labels[action]} 오류: ${err.message}`);
    res.status(500).json({ error: err.message });
  } finally {
    if (client?.disconnect) await client.disconnect().catch(() => {});
  }
});

// ── GET /api/mail/:provider/categorize  (SSE) ────────────────────
router.get('/:provider/categorize', requireAuth, async (req, res) => {
  const { provider } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  function log(level, msg)   { logger[level]('CATEGORIZE', msg); send('log', { message: msg, level }); }

  function getHeader(msg, name) {
    return msg.payload?.headers?.find(
      (h) => h.name.toLowerCase() === name.toLowerCase()
    )?.value || '';
  }

  let client;
  try {
    client = await buildClient(provider, req.session.providers[provider]);

    const { CATEGORIES } = provider === 'cau'
      ? require('../../cau/categories')
      : require('../../categories');

    logger.info('CATEGORIZE', `[${provider}] 자동 분류 시작`);
    log('info', '📂 받은편지함 전체 메시지 헤더 가져오는 중...');
    let metadatas;
    try {
      metadatas = await client.fetchAllMetadata('INBOX');
    } catch (err) {
      logger.error('CATEGORIZE', `[${provider}] 헤더 조회 실패: ${err.message}`);
      log('error', `❌ 헤더 조회 실패: ${err.message}`);
      send('error', { message: `헤더 조회 실패: ${err.message}` });
      return;
    }

    logger.info('CATEGORIZE', `[${provider}] 받은편지함 ${metadatas.length}개 메시지 분석`);
    log('info', `받은편지함 ${metadatas.length}개 메시지 분석 완료`);

    if (!metadatas.length) {
      log('info', '받은편지함에 메일이 없습니다.');
      send('complete', { total: 0 });
      return;
    }

    // 2단계 분류: 광고 감지 → 카테고리 매칭 (matcher.js 사용)
    const buckets = {};
    let skippedAds = 0;

    for (const msg of metadatas) {
      const subject = getHeader(msg, 'Subject');
      const from    = getHeader(msg, 'From');
      const cat     = matchCategory(subject, from, CATEGORIES);

      if (!cat) { skippedAds++; continue; }
      if (!buckets[cat.key]) buckets[cat.key] = { cat, msgs: [] };
      buckets[cat.key].msgs.push(msg);
    }

    if (skippedAds > 0) log('info', `  광고/미분류 제외: ${skippedAds}개`);

    let total = 0;
    const historyResults = [];
    for (const cat of CATEGORIES) {
      const bucket = buckets[cat.key];
      if (!bucket || !bucket.msgs.length) {
        log('info', `  [${cat.name}] 해당 메일 없음`);
        continue;
      }
      const { msgs } = bucket;
      log('info', `  [${cat.name}] ${msgs.length}개 이동 중...`);
      try {
        await client.createFolder(cat.name);
        await client.moveTo(msgs.map((m) => m.id), cat.name);
        total += msgs.length;
        historyResults.push({ key: cat.key, name: cat.name, count: msgs.length });
        logger.success('CATEGORIZE', `[${provider}] [${cat.name}] ${msgs.length}개 이동 완료`);
        log('success', `  ✓ [${cat.name}] ${msgs.length}개 이동 완료`);
      } catch (err) {
        logger.error('CATEGORIZE', `[${provider}] [${cat.name}] 실패: ${err.message}`);
        log('error', `  ✗ [${cat.name}] 실패: ${err.message}`);
      }
    }

    if (historyResults.length > 0) history.addRecord(provider, historyResults);

    logger.success('CATEGORIZE', `[${provider}] 자동 분류 완료 — 총 ${total}개`);
    log('success', `✅ 총 ${total}개 메일 분류 완료`);
    send('complete', { total });
  } catch (err) {
    logger.error('CATEGORIZE', `[${provider}] 분류 오류: ${err.message}`);
    send('error', { message: err.message });
  } finally {
    if (client?.disconnect) await client.disconnect().catch(() => {});
    res.end();
  }
});

// ── GET /api/mail/:provider/queries ───────────────────────────────
router.get('/:provider/queries', requireAuth, (req, res) => {
  const { provider } = req.params;
  try {
    const { QUERIES } = require(`../../${provider}/queries`);
    res.json(QUERIES);
  } catch {
    res.status(404).json({ error: '쿼리 없음' });
  }
});

module.exports = router;
