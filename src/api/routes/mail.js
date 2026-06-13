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

    // Nate 등 IMAP 서버는 한 번 SELECT 시 최대 N개(보통 1000개)만 노출
    // → 분류·이동 후 재조회하면 숨어있던 이전 메일이 새로 나타남
    // Nate는 UID SEARCH도 EXISTS=1000으로 제한 → 한 번에 1000개만 보임
    // 해결책: 미분류(광고) 메일을 임시 폴더로 옮겨 숨김 → 다음 1000개 노출 → 반복
    // 완료 후 임시 폴더를 받은편지함으로 전량 복원
    const TEMP_FOLDER   = '_분류임시_';
    const catTotals     = {};
    let   totalMoved    = 0;
    let   pass          = 0;
    let   tempHasEmails = false;
    const MAX_PASSES    = 500;

    try {
      while (pass < MAX_PASSES) {
        pass++;

        log('info', pass === 1
          ? `📂 받은편지함 전체 스캔 시작 (서버 1000개 제한 → 임시 폴더 방식)`
          : `  ↳ 패스 ${pass}: 남은 메일 스캔 중...`);

        let metadatas;
        try {
          metadatas = await client.fetchAllMetadata('INBOX', (done, total) => {
            if (done === total || done % 2500 === 0) {
              log('info', `  📧 ${done.toLocaleString()} / ${total.toLocaleString()}개 스캔됨`);
            }
          });
        } catch (err) {
          logger.error('CATEGORIZE', `[${provider}] 헤더 조회 실패: ${err.message}`);
          log('error', `❌ 헤더 조회 실패: ${err.message}`);
          break;
        }

        if (!metadatas.length) break; // 받은편지함 비어있음

        logger.info('CATEGORIZE', `[${provider}] 받은편지함 ${metadatas.length}개 메시지 분석`);
        log('info', `  ${metadatas.length.toLocaleString()}개 분석 중... (누적 처리: ${(totalMoved + (tempHasEmails ? '?' : 0)).toLocaleString()}개 이동)`);

        // 카테고리 매칭
        const buckets      = {};
        const uncategorized = [];
        for (const msg of metadatas) {
          const subject = getHeader(msg, 'Subject');
          const from    = getHeader(msg, 'From');
          const cat     = matchCategory(subject, from, CATEGORIES);
          if (!cat) { uncategorized.push(msg); continue; }
          if (!buckets[cat.key]) buckets[cat.key] = { cat, msgs: [] };
          buckets[cat.key].msgs.push(msg);
        }
        if (uncategorized.length) log('info', `  광고/미분류: ${uncategorized.length.toLocaleString()}개`);

        // 카테고리별 이동
        let reconnectFailed = false;
        for (const cat of CATEGORIES) {
          const bucket = buckets[cat.key];
          if (!bucket || !bucket.msgs.length) continue;

          log('info', `  [${cat.name}] ${bucket.msgs.length}개 이동 중...`);
          try {
            await client.moveToWithCreate(bucket.msgs.map(m => m.id), cat.name);
            totalMoved        += bucket.msgs.length;
            catTotals[cat.key] = (catTotals[cat.key] || 0) + bucket.msgs.length;
            logger.success('CATEGORIZE', `[${provider}] [${cat.name}] ${bucket.msgs.length}개 이동 완료`);
            log('success', `  ✓ [${cat.name}] ${bucket.msgs.length}개 이동 완료`);
          } catch (err) {
            const detail = err.responseText ? ` [${err.responseText.trim()}]` : '';
            logger.error('CATEGORIZE', `[${provider}] [${cat.name}] 실패: ${err.message}${detail}`);
            log('error', `  ✗ [${cat.name}] 실패: ${err.message}${detail}`);
            try {
              await client.reconnect();
              logger.info('CATEGORIZE', `[${provider}] 재연결 성공`);
            } catch (reconnErr) {
              logger.error('CATEGORIZE', `[${provider}] 재연결 실패: ${reconnErr.message}`);
              reconnectFailed = true;
              break;
            }
          }
        }
        if (reconnectFailed) break;

        // 미분류 메일을 임시 폴더로 이동해 다음 배치를 노출
        if (uncategorized.length > 0) {
          try {
            log('info', `  📦 미분류 ${uncategorized.length.toLocaleString()}개 임시 보관 중...`);
            await client.moveToWithCreate(uncategorized.map(m => m.id), TEMP_FOLDER);
            tempHasEmails = true;
          } catch (err) {
            log('error', `  임시 이동 실패: ${err.message} — 중단`);
            if (!client.usable) await client.reconnect().catch(() => {});
            break;
          }
        } else {
          // 이번 배치가 전부 분류됨 → 계속 (더 숨겨진 메일이 있을 수 있음)
        }
      }
    } finally {
      // 임시 폴더 → 받은편지함 전량 복원 (오류 여부와 무관하게 항상 실행)
      if (tempHasEmails) {
        log('info', '\n📬 임시 보관 메일 받은편지함으로 복원 중...');
        try {
          if (!client.usable) await client.reconnect();
          const restored = await client.searchAndMoveAll(TEMP_FOLDER, 'INBOX', 200);
          await client.deleteFolder(TEMP_FOLDER);
          log('info', `  ↩️ ${restored.toLocaleString()}개 복원 완료`);
          logger.info('CATEGORIZE', `[${provider}] 임시 폴더 복원 완료 — ${restored}개`);
        } catch (err) {
          log('error', `  ⚠️ 복원 실패: ${err.message}`);
          log('error', `  임시 폴더 '${TEMP_FOLDER}'에 메일이 남아있습니다. 수동으로 받은편지함으로 이동해주세요.`);
          logger.error('CATEGORIZE', `[${provider}] 복원 실패: ${err.message}`);
        }
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
    log('success', `✅ 총 ${totalMoved}개 메일 분류 완료 (${pass}회 패스)`);
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
