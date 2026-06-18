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

  let client;
  try {
    client = await buildClient(provider, req.session.providers[provider]);

    const { CATEGORIES } = provider === 'cau'
      ? require('../../cau/categories')
      : require('../../categories');

    logger.info('CATEGORIZE', `[${provider}] 자동 분류 시작`);

    // Phase0 = CATEGORIZE_TEMP 구조 복구 (RENAME → INBOX.분류임시)
    // Phase1 = INBOX→TEMP (MOVE 1:*, SEARCH 없음)
    // Phase2 = TEMP에서 FETCH+JS matchFn 분류+MOVE
    const TEMP_FOLDER   = 'INBOX.분류임시';
    const OLD_TEMP      = 'CATEGORIZE_TEMP'; // 이전 버전에서 사용하던 최상위 임시 폴더
    const catTotals     = {};
    let   totalMoved    = 0;
    let   tempHasEmails = false;

    // JS matchFn: IMAP SEARCH 대신 FETCH한 envelope을 직접 매칭
    const matchFn = (subject, from) => {
      const cat = matchCategory(subject, from, CATEGORIES);
      return cat ? cat.name : null;
    };

    try {
      // ── Phase 0: 서버 폴더 목록 확인 + CATEGORIZE_TEMP 복구 ──
      let folders = [];
      try {
        folders = await client.listFolders();
        log('info', `📋 서버 폴더 목록: ${folders.join(', ')}`);
      } catch (err) {
        log('error', `  폴더 목록 조회 실패: ${err.message}`);
      }

      // 이전 버전 임시 폴더(CATEGORIZE_TEMP)가 있고 INBOX.분류임시가 없으면 RENAME으로 복구
      const hasOldTemp  = folders.some(f => f === OLD_TEMP || f.endsWith('/' + OLD_TEMP));
      const hasNewTemp  = folders.some(f => f === TEMP_FOLDER || f.includes('분류임시'));
      if (hasOldTemp && !hasNewTemp) {
        log('info', `🔄 ${OLD_TEMP} → ${TEMP_FOLDER} 복구 중...`);
        try {
          await client.renameMailbox(OLD_TEMP, TEMP_FOLDER);
          log('info', `  ✅ 복구 완료 — 이전 임시 폴더 이름 변경 성공`);
          try { await client.reconnect(); } catch (_) {}
        } catch (err) {
          log('error', `  ⚠️ RENAME 실패: ${err.message} — Phase 1에서 INBOX 재확인`);
        }
      } else if (hasOldTemp && hasNewTemp) {
        log('info', `  양쪽 임시 폴더 모두 존재: ${OLD_TEMP}, ${TEMP_FOLDER}`);
      }

      // ── Phase 1: INBOX → INBOX.분류임시 ──
      log('info', '📂 Phase 1: 받은편지함 → 임시 폴더 이동 중...');
      let drained = 0;
      try {
        drained = await client.drainInboxToTemp(TEMP_FOLDER, (n) =>
          log('info', `  📦 ${n.toLocaleString()}개 임시 이동 완료`)
        );
        log('info', `  총 ${drained.toLocaleString()}개 임시 폴더로 이동`);
      } catch (err) {
        log('error', `❌ INBOX 이동 실패: ${err.message}`);
      }

      // Phase 1 후 반드시 재연결: INBOX SELECT 상태에서 TEMP 폴더 전환 시 Nate BYE 방지
      try { await client.reconnect(); } catch (_) {}

      // TEMP 메일 수 확인 (진단용 로그)
      let tempCount = 0;
      try {
        tempCount = await client.getMailboxExists(TEMP_FOLDER);
        log('info', `  임시 폴더 메일 수: ${tempCount.toLocaleString()}개`);
      } catch (err) {
        const detail = err.responseText ? ` [${err.responseText.trim()}]` : '';
        log('error', `  임시 폴더 확인 실패: ${err.message}${detail}`);
        // tempCount=0이어도 Phase 2 진행 (TEMP에 메일이 있을 수 있음)
      }
      tempHasEmails = true; // 항상 Phase 2·복원 시도 (TEMP 비어있으면 FETCH가 0 반환하고 즉시 종료)

      // ── Phase 2: CATEGORIZE_TEMP FETCH → matchFn → MOVE ──
      log('info', '📂 Phase 2: 임시 폴더에서 카테고리 분류 중 (FETCH 방식)...');
      const MAX_PASSES = 60;
      let consecutiveLockFails = 0;

      for (let pass = 0; pass < MAX_PASSES; pass++) {
        let fetchResult;
        try {
          if (!client.usable) await client.reconnect();
          fetchResult = await client.fetchFolderClassified(TEMP_FOLDER, matchFn, (n) => {
            if (n % 1000 === 0) log('info', `  📧 ${n.toLocaleString()}개 조회 중...`);
          });
          consecutiveLockFails = 0;
        } catch (err) {
          // getMailboxLock 실패: 폴더 없음 또는 연결 불가
          const detail = err.responseText ? ` [${err.responseText.trim()}]` : '';
          log('error', `❌ FETCH 잠금 실패 (${pass + 1}회): ${err.message}${detail}`);
          consecutiveLockFails++;
          if (consecutiveLockFails >= 3) break; // 3회 연속 잠금 실패 → TEMP 없음
          try { await client.reconnect(); } catch (_) {}
          continue;
        }
        if (fetchResult.error) log('error', `⚠️ FETCH 중단: ${fetchResult.error.message}`);

        const { buckets, total, error: fetchErr } = fetchResult;
        const catCount = Object.values(buckets).reduce((a, arr) => a + arr.length, 0);
        log('info', `  조회 ${total.toLocaleString()}개, 분류 대상 ${catCount.toLocaleString()}개`);

        if (catCount > 0) {
          try {
            if (!client.usable) await client.reconnect();
            const moveResult = await client.moveCategorizedFromFolder(TEMP_FOLDER, buckets);
            for (const [folderName, count] of Object.entries(moveResult.catMoved)) {
              const cat  = CATEGORIES.find(c => c.name === folderName);
              totalMoved += count;
              catTotals[cat?.key || folderName] = (catTotals[cat?.key || folderName] || 0) + count;
              log('success', `  ✓ [${folderName}] ${count}개 이동`);
            }
          } catch (moveErr) {
            log('error', `  ⚠️ MOVE 실패: ${moveErr.message}`);
            try { await client.reconnect(); } catch (_) {}
            continue;
          }
        }

        if (catCount === 0 && !fetchErr) break; // FETCH 완료 + 분류 대상 없음 → 완료
        if (fetchErr) {
          try { await client.reconnect(); } catch (_) {}
        }
      }
    } finally {
      // 미분류 메일 INBOX 복원 (TEMP 없거나 비어있으면 복원도 0건 → 정상)
      log('info', '\n📬 임시 보관 메일 받은편지함으로 복원 중...');
      try {
        if (!client.usable) await client.reconnect();
        let restored;
        try {
          restored = await client.searchAndMoveAll(TEMP_FOLDER, 'INBOX', 200);
        } catch (err) {
          log('error', `  복원 1차 실패: ${err.message}`);
          await client.reconnect();
          restored = await client.searchAndMoveAll(TEMP_FOLDER, 'INBOX', 200);
        }
        if (restored > 0) {
          try { await client.deleteFolder(TEMP_FOLDER); } catch (_) {}
          log('info', `  ↩️ ${restored.toLocaleString()}개 복원 완료`);
          logger.info('CATEGORIZE', `[${provider}] 임시 폴더 복원 완료 — ${restored}개`);
        } else {
          log('info', `  복원할 미분류 메일 없음`);
        }
      } catch (err) {
        log('error', `  ⚠️ 복원 실패: ${err.message}`);
        log('error', `  임시 폴더 '${TEMP_FOLDER}'에 메일이 남아있습니다. 수동으로 받은편지함으로 이동해주세요.`);
        logger.error('CATEGORIZE', `[${provider}] 복원 실패: ${err.message}`);
      }
    }

    // 카테고리별 최종 결과 표시
    for (const cat of CATEGORIES) {
      if (!catTotals[cat.key]) log('info', `  [${cat.name}] 해당 메일 없음`);
    }

    const historyResults = Object.entries(catTotals).map(([key, count]) => ({
      key, count, name: CATEGORIES.find(c => c.key === key)?.name || key,
    }));
    if (historyResults.length > 0) history.addRecord(provider, historyResults);

    logger.success('CATEGORIZE', `[${provider}] 자동 분류 완료 — 총 ${totalMoved}개`);
    log('success', `✅ 총 ${totalMoved}개 메일 분류 완료`);
    send('complete', { total: totalMoved });
  } catch (err) {
    logger.error('CATEGORIZE', `[${provider}] 분류 오류: ${err.message}`);
    send('error', { message: err.message });
  } finally {
    if (client?.disconnect) await client.disconnect().catch(() => {});
    res.end();
  }
});

// ── GET /api/mail/:provider/migrate-folders  (SSE) ───────────────
router.get('/:provider/migrate-folders', requireAuth, async (req, res) => {
  const { provider } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  function log(level, msg)   { logger[level]('MIGRATE', msg); send('log', { message: msg, level }); }

  let client;
  try {
    client = await buildClient(provider, req.session.providers[provider]);

    const { CATEGORIES } = provider === 'cau'
      ? require('../../cau/categories')
      : require('../../categories');

    logger.info('MIGRATE', `[${provider}] 폴더 이름 마이그레이션 시작`);
    let totalMoved = 0;

    if (provider === 'gmail') {
      log('info', 'Gmail 레이블 목록 조회 중...');
      const labels = await client.listLabels();

      for (const cat of CATEGORIES) {
        const oldLabel = labels.find((l) => l.name === cat.key);
        if (!oldLabel) continue;

        log('info', `  [${cat.key}] → [${cat.name}] 마이그레이션 중...`);
        try {
          const msgIds = await client.getMessagesInLabel(oldLabel.id);
          const newLabelId = await client.getOrCreateLabel(cat.name);

          if (msgIds.length) {
            await client.applyLabel(msgIds, newLabelId);
            await client.removeLabelsFromMessages(msgIds, oldLabel.id);
            totalMoved += msgIds.length;
          }

          await client.deleteLabel(oldLabel.id);
          log('success', `  ✓ [${cat.name}] ${msgIds.length}개 이동, 기존 레이블 삭제 완료`);
        } catch (err) {
          log('error', `  ✗ [${cat.name}] 실패: ${err.message}`);
        }
      }
    } else {
      // EXAMINE → SELECT 전환 시 Nate가 BYE를 보내는 문제를 근본 해결:
      // searchAndMoveAll 로 SELECT 한 번에 검색+이동 처리
      outerLoop: for (const cat of CATEGORIES) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const moved = await client.searchAndMoveAll(cat.key, cat.name);
            await client.deleteFolder(cat.key);
            totalMoved += moved;
            if (moved > 0) {
              log('success', `  ✓ [${cat.key}] → [${cat.name}] ${moved}개 이동, 폴더 삭제 완료`);
            }
            break;
          } catch (err) {
            const errMsg = `${err.message || ''} ${err.responseText || ''}`.toLowerCase();
            // 원본 폴더 없음 (이미 삭제/마이그레이션 완료) — 연결이 끊겼으면 조용히 재연결
            if (errMsg.includes('nonexistent') || errMsg.includes('does not exist') ||
                errMsg.includes('no such') || errMsg.includes('not found')) {
              if (!client.usable) {
                await new Promise((r) => setTimeout(r, 500));
                await client.reconnect().catch(() => {});
              }
              break;
            }
            const detail = err.responseText ? ` [${err.responseText.trim()}]` : '';
            log('error', `  ✗ [${cat.key}] 실패 (${attempt}/2): ${err.message}${detail}`);
            if (attempt < 2) {
              await new Promise((r) => setTimeout(r, 1000));
              try { await client.reconnect(); }
              catch (reconnErr) {
                log('error', `  재연결 실패: ${reconnErr.message} — 중단`);
                break outerLoop;
              }
            }
          }
        }
      }
    }

    logger.success('MIGRATE', `[${provider}] 마이그레이션 완료 — 총 ${totalMoved}개`);
    log('success', `✅ 마이그레이션 완료 — 총 ${totalMoved}개 메일 이동됨`);
    send('complete', { total: totalMoved });
  } catch (err) {
    logger.error('MIGRATE', `[${provider}] 마이그레이션 오류: ${err.message}`);
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
