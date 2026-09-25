const express = require('express');
const router  = express.Router();
const logger  = require('../../logger');
const history = require('../../history');
const { matchCategory } = require('../../matcher');

// ── 중복 스캔/삭제 공용 헬퍼 ──────────────────────────────────────
// find-duplicates·dedupe 라우트뿐 아니라, 이동 작업(전체 재분류 실행 등) 끝에도
// 안전망으로 재사용한다 — Nate의 "복사 후 원본삭제" MOVE 에뮬레이션이 연결 끊김과
// 겹치면 원본 삭제 없이 복사만 반복돼 중복이 생길 수 있어, 작업 후 항상 이걸로 청소한다.
// 사용자가 직접 관리하는 기록 폴더 — 이 앱의 이동 작업이 건드리지 않으므로 중복 정리에서 뺀다
// (예: 나에게 보낸 메일은 보낸편지함과 받은편지함에 같은 Message-ID로 정상적으로 두 통 있다)
const DEDUPE_EXCLUDED_FOLDERS = new Set([
  'Sent Messages', 'Drafts', 'Deleted Messages', '내게쓴메일함', '보낸메일함', '임시보관함', '휴지통',
]);

async function scanAllFoldersForDuplicates(client, log) {
  const folders = (await client.listFolders()).filter((f) => !DEDUPE_EXCLUDED_FOLDERS.has(f));
  log('info', `📋 전체 폴더 ${folders.length}개 읽기전용 스캔 시작 (이동/삭제 없음): ${folders.join(', ')}`);

  const all = [];
  for (const folder of folders) {
    let items;
    try {
      items = await client.scanFolderAllMessages(folder);
    } catch (err) {
      log('warn', `  "${folder}" 스캔 실패(${err.message}) — 재연결 후 재시도`);
      try {
        await client.reconnect();
        items = await client.scanFolderAllMessages(folder);
      } catch (err2) {
        log('error', `  "${folder}" 재시도도 실패: ${err2.message}`);
        continue;
      }
    }
    all.push(...items.map((it) => ({ folder, ...it })));
    log('info', `  "${folder}" — ${items.length.toLocaleString()}통`);
  }

  // Message-ID가 없는(또는 빈) 메일도 적지 않아 — 그런 경우 제목+발신자+날짜(초 단위)로
  // 묶는다. 같은 원본을 반복 복사한 경우 이 세 값이 완전히 동일하므로 정상 메일을
  // 잘못 묶을 위험은 거의 없다.
  let noMessageId = 0;
  const byKey = {};
  for (const it of all) {
    if (!it.messageId) noMessageId++;
    const key = it.messageId || `subj:${it.subject}|from:${it.from}|date:${it.date}`;
    (byKey[key] ||= []).push(it);
  }
  if (noMessageId) log('warn', `  ⚠️ Message-ID 없는 메일 ${noMessageId.toLocaleString()}통 — 제목+발신자+날짜로 대체 비교`);

  const dupGroups = Object.entries(byKey)
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ messageId: key, count: list.length, copies: list }));

  return { totalScanned: all.length, dupGroups };
}

// 그룹당 1통(가능하면 INBOX 사본)만 남기고 나머지를 삭제
async function dedupeGroups(client, dupGroups, log) {
  const toDeleteByFolder = {};
  let keepCount = 0;
  for (const g of dupGroups) {
    const inboxCopies = g.copies.filter((c) => c.folder === 'INBOX');
    const pool = inboxCopies.length ? inboxCopies : g.copies;
    const keep = pool.reduce((a, b) => (a.uid < b.uid ? a : b));
    keepCount++;
    for (const c of g.copies) {
      if (c.folder === keep.folder && c.uid === keep.uid) continue;
      (toDeleteByFolder[c.folder] ||= []).push(c.uid);
    }
  }
  const totalToDelete = Object.values(toDeleteByFolder).reduce((s, l) => s + l.length, 0);
  if (!totalToDelete) return { deleted: 0, planned: 0 };
  log('info', `🗑️ 중복 삭제 대상 ${totalToDelete.toLocaleString()}통 (${keepCount}개 그룹, 그룹당 1통 유지) — 폴더: ${Object.entries(toDeleteByFolder).map(([f, l]) => `${f}(${l.length})`).join(', ')}`);

  let deleted = 0;
  for (const [folder, uids] of Object.entries(toDeleteByFolder)) {
    try {
      const n = await client.deleteExactUids(folder, uids);
      deleted += n;
      log('success', `  ✓ "${folder}" — ${n.toLocaleString()}통 중복 삭제`);
    } catch (err) {
      log('error', `  ⚠️ "${folder}" 중복 삭제 건너뜀: ${err.message}`);
    }
  }
  return { deleted, planned: totalToDelete };
}

// find-duplicates·dedupe와 동일한 결과를 내도록 스캔→삭제를 한 번에 수행 (자동 안전망용)
async function scanAndDedupe(client, log) {
  const { dupGroups } = await scanAllFoldersForDuplicates(client, log);
  if (!dupGroups.length) { log('info', '  중복 없음'); return { deleted: 0, planned: 0 }; }
  return dedupeGroups(client, dupGroups, log);
}

// 분류로 옮긴 결과를 기록한다 — 카테고리별 개수와 함께 제목을 최대 5개씩 로그에 남겨,
// 나중에 어떤 메일이 어디로 갔는지 확인할 수 있게 한다. 옮긴 UID는 seen에 넣어 다시 옮기지 않는다.
function recordMoves(moveResult, { subjects, seen, catTotals, CATEGORIES, log }) {
  let moved = 0;
  for (const [folderName, count] of Object.entries(moveResult.catMoved || {})) {
    const uids = moveResult.movedUids?.[folderName] || [];
    uids.forEach((u) => seen.add(u));
    const cat = CATEGORIES.find((c) => c.name === folderName);
    catTotals[cat?.key || folderName] = (catTotals[cat?.key || folderName] || 0) + count;
    moved += count;
    log('success', `  ✓ [${folderName}] ${count}개 이동`);
    for (const u of uids.slice(0, 5)) log('info', `      · ${subjects?.[u] || '(제목 확인 불가)'}`);
    if (uids.length > 5) log('info', `      · 외 ${uids.length - 5}통`);
  }
  return moved;
}

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
      // 직전 auth 검증 연결의 LOGOUT이 Nate 서버에서 정리되기 전에 바로 재연결하면
      // 중복 세션으로 보고 끊는 경우가 잦음 — 첫 시도 전에도 짧게 대기하고,
      // 재시도 간격도 점점 늘려(3→5→8→13초) 서버 쪽 정리 시간을 넉넉히 준다
      await new Promise(r => setTimeout(r, 1500));
      client = new NateClient({ user: sessionData.user, password: sessionData.password });
      const delays = [3000, 5000, 8000, 13000];
      for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
        try {
          await client.connect();
          break;
        } catch (err) {
          if (attempt === delays.length + 1) throw err;
          const wait = delays[attempt - 1];
          logger.warn('SYSTEM', `[nate] 연결 실패 (${attempt}회), ${wait / 1000}초 후 재시도...`);
          try { client.imap.close(); } catch (_) {}
          await new Promise(r => setTimeout(r, wait));
          client = new NateClient({ user: sessionData.user, password: sessionData.password });
        }
      }
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
    const { QUERIES, buildCriteria, BAYES_TRAIN } = require(`../../${provider}/queries`);

    const readLabel = readFilter === 'is:unread' ? '미열람' : readFilter === 'is:read' ? '열람' : '전체';
    logger.info('SCAN', `[${provider}] 스캔 시작 — 카테고리 ${selectedKeys.length}개 | 필터: ${readLabel}`);
    send('start', { total: selectedKeys.length });

    const results = {};
    for (const key of selectedKeys) {
      const def = QUERIES[key];
      if (!def) continue;

      logger.info('SCAN', `  [${def.name}] 검색 중...`);
      send('progress', { key, name: def.name, status: 'scanning' });

      try {
        const messages = def.matcher === 'detectAd'
          ? await client.scanInboxForAds(readFilter, undefined, BAYES_TRAIN)
          : await client.searchInFolder(def.folder, buildCriteria(key, readFilter));

        const samples = messages.length
          ? await client.getMetadata(messages.slice(0, 50).map((m) => m.id))
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
      } catch (err) {
        // IMAP 서버는 실패 사유를 err.responseText/executedCommand에 담아 보냄
        // (err.message는 항상 'Command failed'로 동일해 원인 파악 불가 — 상세 정보 로깅)
        const detail = err.responseText ? ` [${err.responseStatus || 'ERR'}: ${err.responseText.trim()}]` : '';
        const cmd    = err.executedCommand ? ` (${err.executedCommand})` : '';
        logger.error('SCAN', `  [${def.name}] 검색 실패: ${err.message}${detail}${cmd}`);
        results[key] = { name: def.name, description: def.description, count: 0, ids: [], samples: [], error: err.message + detail };
        send('progress', { key, name: def.name, status: 'error', message: err.message + detail });

        // 연결이 끊겼으면(Nate가 Command failed 후 BYE를 보내는 경우 등) 재연결 후 다음 카테고리 계속 진행
        if (client.usable === false && typeof client.reconnect === 'function') {
          try {
            await client.reconnect();
            logger.info('SCAN', `[${provider}] 재연결 성공 — 다음 카테고리 계속 진행`);
          } catch (reconnErr) {
            logger.error('SCAN', `[${provider}] 재연결 실패: ${reconnErr.message} — 남은 카테고리 중단`);
            break;
          }
        }
      }
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

  async function runAction(c) {
    if (action === 'trash')  return c.trashMessages(ids);
    if (action === 'delete') return c.deleteMessages(ids);
    if (action === 'spam')   return c.markAsSpam(ids);
  }

  let client;
  try {
    client = await buildClient(provider, req.session.providers[provider]);
    let count;
    try {
      count = await runAction(client);
    } catch (err) {
      // Nate 등 IMAP 서버가 연결 직후 소켓을 끊는 경우 대비 — 재연결 후 한 번 더 시도
      if (typeof client.reconnect === 'function') {
        const detail = err.responseText ? ` [${err.responseStatus || 'ERR'}: ${err.responseText.trim()}]` : '';
        logger.warn('CLEAN', `[${provider}] ${labels[action]} 실패(${err.message}${detail}) — 재연결 후 재시도`);
        await client.reconnect();
        count = await runAction(client);
      } else {
        throw err;
      }
    }
    logger.success('CLEAN', `[${provider}] ${labels[action]} 완료 — ${count}개 처리됨`);
    res.json({ success: true, count });
  } catch (err) {
    const detail = err.responseText ? ` [${err.responseStatus || 'ERR'}: ${err.responseText.trim()}]` : '';
    logger.error('CLEAN', `[${provider}] ${labels[action]} 오류: ${err.message}${detail}`);
    res.status(500).json({ error: err.message + detail });
  } finally {
    if (client?.disconnect) await client.disconnect().catch(() => {});
  }
});

// ── GET /api/mail/:provider/categorize  (SSE) ────────────────────
// 분류 실행: 받은편지함에 있는 메일만 제자리에서 분류 — 임시 폴더로 옮기지 않고,
// 분류 대상이 아닌 메일은 받은편지함에 그대로 둔다. 이미 카테고리 폴더에 있는 메일은 건드리지 않는다.
router.get('/:provider/categorize', requireAuth, async (req, res) => {
  const { provider } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  function log(level, msg)   { logger[level]('CATEGORIZE', msg); send('log', { message: msg, level }); }

  const WINDOW = 1000; // Nate는 폴더당 1000통까지만 노출
  let client;
  try {
    client = await buildClient(provider, req.session.providers[provider]);

    const { CATEGORIES } = provider === 'cau'
      ? require('../../cau/categories')
      : require('../../categories');

    logger.info('CATEGORIZE', `[${provider}] 받은편지함 분류 시작`);

    const matchFn = (subject, from) => {
      const cat = matchCategory(subject, from, CATEGORIES);
      return cat ? cat.name : null;
    };

    const safeReconnect = async () => {
      for (let i = 0; i < 3; i++) {
        try { await client.reconnect(); return true; } catch (_) {}
        await new Promise(r => setTimeout(r, 2000));
      }
      return false;
    };

    try {
      const folders = await client.listFolders();
      if (folders.includes('SortTemp')) {
        log('warn', "⚠️ 이전 분류가 중단되어 'SortTemp' 폴더에 메일이 남아있습니다. '전체 재분류 실행'으로 마무리해주세요.");
      }
    } catch (_) { /* 폴더 목록을 못 읽어도 분류는 계속 */ }

    // 사전 점검: 이 앱이 표시하지 않은 \Deleted 메일이 이동 중 EXPUNGE에 같이 지워지지 않게 표시를 해제
    // (메일은 보존됨) — 새 연결로 확인해 남아있으면 아무것도 옮기지 않고 중단
    let stillFlagged = 0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const preCleared = await client.clearDeletedFlags('INBOX');
      if (preCleared) log('warn', `  ⚠️ 받은편지함에 삭제 표시만 된 메일 ${preCleared}통 — 표시 해제 (메일은 보존)`);
      await safeReconnect();
      stillFlagged = await client.countDeletedFlagged('INBOX');
      if (!stillFlagged) break;
    }
    if (stillFlagged) throw new Error(`받은편지함에 삭제 표시된 메일 ${stillFlagged}통이 해제되지 않아 안전을 위해 중단합니다 (아무 메일도 옮기지 않았습니다)`);

    const catTotals = {};
    let totalMoved  = 0;
    let moveFailed  = false;
    const seen      = new Set(); // 이미 이동을 요청한 UID — 이동 직후 Nate 목록이 갱신 전이어도 다시 옮기지 않는다

    for (let pass = 0; pass < 50; pass++) {
      const { buckets, subjects, total, error: fetchErr } = await client.fetchFolderClassified('INBOX', matchFn, (n) => {
        if (n % 1000 === 0) log('info', `  📧 ${n.toLocaleString()}개 조회 중...`);
      });
      if (fetchErr) {
        log('error', `❌ 받은편지함 조회 중단: ${fetchErr.message}`);
        break;
      }

      const fresh = {};
      let freshCount = 0;
      for (const [name, uids] of Object.entries(buckets)) {
        const list = uids.filter((u) => !seen.has(u));
        if (list.length) { fresh[name] = list; freshCount += list.length; }
      }
      log('info', `  받은편지함 ${total.toLocaleString()}통 조회, 분류 대상 ${freshCount.toLocaleString()}통`);

      if (freshCount === 0) {
        if (total >= WINDOW) {
          log('warn', `⚠️ 받은편지함이 ${WINDOW.toLocaleString()}통 이상이라 일부만 확인됩니다. 나머지는 '전체 재분류 실행'으로 처리해주세요.`);
        }
        break;
      }

      try {
        const moveResult = await client.moveCategorizedFromFolder('INBOX', fresh);
        Object.values(fresh).forEach((uids) => uids.forEach((u) => seen.add(u)));
        totalMoved += recordMoves(moveResult, { subjects, seen, catTotals, CATEGORIES, log });
      } catch (moveErr) {
        if (moveErr.partial) totalMoved += recordMoves(moveErr.partial, { subjects, seen, catTotals, CATEGORIES, log });
        log('error', `  ⚠️ 이동 실패: ${moveErr.message} — 중복 이동을 막기 위해 여기서 중단합니다.`);
        moveFailed = true;
        break;
      }

      if (total < WINDOW) break; // 받은편지함이 전부 보였으므로 한 번으로 충분
      await safeReconnect();
    }

    // 옮긴 메일의 원본이 받은편지함에서 실제로 사라졌는지 새 연결로 확인한다. Nate는 EXPUNGE에
    // 항상 "지울 메일 없음"이라고 답하고 실제 삭제는 나중에 반영하므로 응답만으로는 알 수 없다.
    // 원본이 남아 있으면 중복이 된 것이라 아래 중복 정리로 넘긴다.
    let leftovers = 0;
    if (seen.size && !moveFailed) {
      try {
        await safeReconnect();
        leftovers = (await client.findExistingUids('INBOX', [...seen])).length;
        if (leftovers) log('warn', `  ⚠️ 옮긴 메일 중 ${leftovers}통의 원본이 받은편지함에 남아 있음 — 중복 정리를 진행합니다`);
        else log('info', '  ✅ 옮긴 메일의 원본이 받은편지함에서 모두 사라진 것 확인');
      } catch (err) {
        log('warn', `  ⚠️ 원본 확인 실패: ${err.message} — 중복 정리를 진행합니다`);
        leftovers = -1;
      }
    }

    // 이동이 도중에 실패했거나 원본이 남아 있으면, "복사는 됐는데 원본은 삭제 표시만 된" 메일을 정리한다
    if (moveFailed || leftovers) {
      log('info', '\n🔍 중복 메일 확인 중...');
      try {
        await safeReconnect();
        const n = await client.clearDeletedFlags('INBOX');
        if (n) log('info', `  받은편지함 삭제 표시 ${n}통 해제 (메일은 보존)`);
        await safeReconnect();
        const { deleted, planned } = await scanAndDedupe(client, (level, msg) => log(level, `  ${msg}`));
        if (deleted) log('success', `  ✅ 중복 ${deleted.toLocaleString()}통 자동 정리 완료`);
        else if (planned) log('warn', `  ⚠️ 중복 ${planned.toLocaleString()}통 발견했지만 일부만 정리됨 — '중복 메일 찾기'로 다시 확인해주세요`);
      } catch (err) {
        log('error', `  ⚠️ 중복 확인 실패: ${err.message} — '중복 메일 찾기'를 별도로 실행해주세요`);
      }
    }

    const historyResults = Object.entries(catTotals).map(([key, count]) => ({
      key, count, name: CATEGORIES.find(c => c.key === key)?.name || key,
    }));
    if (historyResults.length > 0) history.addRecord(provider, historyResults);

    logger.success('CATEGORIZE', `[${provider}] 받은편지함 분류 완료 — 총 ${totalMoved}개`);
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

// ── GET /api/mail/:provider/categorize-all  (SSE) ────────────────
// 전체 재분류 실행: 받은편지함 전체를 임시 폴더(SortTemp)로 옮긴 뒤 분류하고, 남은 메일은 복원
router.get('/:provider/categorize-all', requireAuth, async (req, res) => {
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

    // 임시 폴더명은 반드시 ASCII — 한국어는 Modified UTF-7 인코딩 불일치로 Nate SELECT 실패
    const TEMP_FOLDER   = 'SortTemp';
    // 이전 버전 임시 폴더명 목록 (RENAME으로 복구)
    const OLD_TEMPS     = ['CATEGORIZE_TEMP', 'INBOX.분류임시', '분류임시'];
    const catTotals     = {};
    let   totalMoved    = 0;
    let   tempHasEmails = false;
    let   restoredEarly = 0; // 2단계에서 바로 받은편지함으로 돌려보낸 메일 수

    // JS matchFn: IMAP SEARCH 대신 FETCH한 envelope을 직접 매칭
    const matchFn = (subject, from) => {
      const cat = matchCategory(subject, from, CATEGORIES);
      return cat ? cat.name : null;
    };

    // 안정적인 재연결 헬퍼 (최대 3회 재시도)
    const safeReconnect = async () => {
      for (let i = 0; i < 3; i++) {
        try { await client.reconnect(); return true; } catch (_) {}
        await new Promise(r => setTimeout(r, 2000));
      }
      return false;
    };

    try {
      // ── Phase 0: 서버 폴더 목록 확인 + 메일 분포 파악 ──
      let folders = [];
      try {
        folders = await client.listFolders();
        log('info', `📋 서버 폴더 목록: ${folders.join(', ')}`);
      } catch (err) {
        log('error', `  폴더 목록 조회 실패: ${err.message}`);
      }

      let hasNewTemp = folders.some(f => f === TEMP_FOLDER);

      // 이전 버전 임시 폴더 → SortTemp 로 RENAME 복구 (SELECT 없이 RENAME만으로 처리 가능)
      if (!hasNewTemp) {
        for (const oldName of OLD_TEMPS) {
          const found = folders.some(f => f === oldName || f.includes(oldName));
          if (!found) continue;
          log('info', `🔄 이전 임시 폴더 발견: ${oldName} → ${TEMP_FOLDER} 복구 중...`);
          try {
            await client.renameMailbox(oldName, TEMP_FOLDER);
            log('info', `  ✅ 복구 완료`);
            hasNewTemp = true;
            await safeReconnect().catch(() => {});
          } catch (err) {
            log('error', `  ⚠️ RENAME 실패: ${err.message}`);
          }
          break;
        }
      }

      // SortTemp 명시적 사전 생성 — TRYCREATE 방식은 Nate에서 \Noselect 폴더를 만들어
      // SELECT가 거부됨. Phase 1 전에 CREATE로 정식 폴더를 만들어두면 TRYCREATE 불필요
      if (!hasNewTemp) {
        try {
          await client.createFolder(TEMP_FOLDER);
          log('info', `  ✅ 임시 폴더 사전 생성 완료 (${TEMP_FOLDER})`);
        } catch (err) {
          log('warn', `  임시 폴더 사전 생성 실패: ${err.message}`);
        }
      }

      // ── 사전 점검 ──
      // Nate는 EXPUNGE가 폴더 전체의 \Deleted 메일을 지우므로, 이 앱이 표시하지 않은 \Deleted
      // 메일이 있으면 이동 중에 같이 지워질 수 있다. 표시를 해제하고(메일은 보존됨), 새 연결로
      // 다시 확인해 남아있으면 아무것도 옮기지 않고 중단한다.
      const existingNow = await client.listFolders();
      const preflightFolders = ['INBOX', TEMP_FOLDER].filter((f) => f === 'INBOX' || existingNow.includes(f));
      let stillFlagged = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        for (const f of preflightFolders) {
          const n = await client.clearDeletedFlags(f);
          if (n) log('warn', `  ⚠️ "${f}"에 삭제 표시만 된 메일 ${n}통 — 표시 해제 (메일은 보존)`);
        }
        await safeReconnect();
        stillFlagged = [];
        for (const f of preflightFolders) {
          const left = await client.countDeletedFlagged(f);
          if (left) stillFlagged.push(`"${f}" ${left}통`);
        }
        if (!stillFlagged.length) break;
      }
      if (stillFlagged.length) {
        throw new Error(`삭제 표시된 메일(${stillFlagged.join(', ')})이 해제되지 않아 안전을 위해 중단합니다 (아무 메일도 옮기지 않았습니다)`);
      }
      log('info', '  ✅ 사전 점검 통과');

      // Phase 1 전 재연결 — Phase 0 작업(listFolders·rename·create) 후 클린 상태 보장
      await safeReconnect().catch(() => {});

      // ── Phase 1: INBOX → 임시 폴더 ──
      // searchAndMoveAll 사용: UID SEARCH ALL + UID MOVE — ImapFlow stale EXISTS=0 우회
      // Nate 1,000개 슬라이딩 윈도우를 패스마다 소진하여 전체 메일 처리
      log('info', '📂 Phase 1: 받은편지함 전체 → 임시 폴더 이동 중...');
      let drained = 0;
      try {
        drained = await client.searchAndMoveAll('INBOX', TEMP_FOLDER, 50, (n) => {
          if (n % 1000 === 0) log('info', `  📦 ${n.toLocaleString()}개 임시 이동 완료...`);
        });
        log('info', `  총 ${drained.toLocaleString()}개 임시 폴더로 이동`);
        if (drained > 0) hasNewTemp = true;
      } catch (err) {
        log('error', `❌ INBOX 이동 실패: ${err.message}`);
      }

      // Phase 1 후 재연결 (실패해도 계속 — searchAndMoveAll 내부에서 재연결 처리)
      await safeReconnect().catch(() => {});

      if (!hasNewTemp) {
        log('info', '⚠️ INBOX가 비어있습니다. 분류할 메일이 없습니다.');
        tempHasEmails = false;
      } else {
        tempHasEmails = true;
      }

      if (tempHasEmails) {

      // TEMP 메일 수 확인 (진단용)
      try {
        const tempCount = await client.getMailboxExists(TEMP_FOLDER);
        log('info', `  임시 폴더 메일 수: ${tempCount.toLocaleString()}개`);
        await safeReconnect();
      } catch (err) {
        log('error', `  임시 폴더 확인 실패: ${err.message}`);
        await safeReconnect();
      }

      // ── Phase 2: TEMP FETCH → matchFn → MOVE ──
      log('info', '📂 Phase 2: 임시 폴더에서 카테고리 분류 중...');
      // Nate는 같은 연결 안에서는 이미 옮긴 메일을 FETCH에 계속 돌려준다(갱신 지연) — 예전에는
      // 같은 메일을 매번 다시 옮기고 다시 세서 "690개 분류"처럼 부풀었다. 이번 실행에서 옮긴 UID는
      // 건너뛰고, 옮길 게 없어지면 새 연결로 한 번 더 확인한 뒤(1000통 표시 창이 밀려 새로
      // 드러난 메일 처리) 그래도 없으면 끝낸다.
      const MAX_PASSES = 2000;
      const seen = new Set();
      let consecutiveLockFails = 0;
      let consecutiveMoveFails = 0; // 이동이 계속 실패하면 몇 시간씩 같은 실패를 반복하지 않고 복원 단계로 넘어간다
      let consecutiveFetchErrs = 0;
      let confirmedOnFreshConn = false;

      for (let pass = 0; pass < MAX_PASSES; pass++) {
        let fetchResult;
        try {
          if (!client.usable) await safeReconnect();
          fetchResult = await client.fetchFolderClassified(TEMP_FOLDER, matchFn, (n) => {
            if (n % 1000 === 0) log('info', `  📧 ${n.toLocaleString()}개 조회 중...`);
          });
          consecutiveLockFails = 0;
        } catch (err) {
          const detail = err.responseText ? ` [${err.responseText.trim()}]` : '';
          log('error', `❌ FETCH 잠금 실패 (${pass + 1}회): ${err.message}${detail}`);
          consecutiveLockFails++;
          if (consecutiveLockFails >= 3) break;
          await safeReconnect();
          continue;
        }

        const { buckets, subjects, unmatched, total, error: fetchErr } = fetchResult;
        if (fetchErr) {
          log('error', `⚠️ FETCH 중단: ${fetchErr.message}`);
          if (++consecutiveFetchErrs >= 3) break;
        } else {
          consecutiveFetchErrs = 0;
        }

        const fresh = {};
        let freshCount = 0;
        for (const [name, uids] of Object.entries(buckets)) {
          const list = uids.filter((u) => !seen.has(u));
          if (list.length) { fresh[name] = list; freshCount += list.length; }
        }

        // 분류 대상이 아닌 메일은 이번에 확인이 끝났으므로 바로 받은편지함으로 돌려보낸다 — 임시 폴더에
        // 남겨두면 Nate의 1000통 표시 창을 계속 차지해 그 뒤의 메일이 영영 안 보인다
        const freshOthers = (unmatched || []).filter((u) => !seen.has(u));

        if (freshCount === 0 && freshOthers.length === 0) {
          if (fetchErr) { await safeReconnect(); continue; }
          if (confirmedOnFreshConn) break;
          confirmedOnFreshConn = true; // 새 연결로 한 번 더 확인
          await safeReconnect();
          continue;
        }
        confirmedOnFreshConn = false;
        log('info', `  조회 ${total.toLocaleString()}개 — 분류 대상 ${freshCount.toLocaleString()}개, 해당 없음 ${freshOthers.length.toLocaleString()}개`);

        try {
          if (!client.usable) await safeReconnect();
          if (freshCount) {
            const moveResult = await client.moveCategorizedFromFolder(TEMP_FOLDER, fresh);
            totalMoved += recordMoves(moveResult, { subjects, seen, catTotals, CATEGORIES, log });
          }
          if (freshOthers.length) {
            const back = await client.moveUids(TEMP_FOLDER, freshOthers, 'INBOX');
            back.forEach((u) => seen.add(u));
            restoredEarly += back.length;
            log('info', `  ↩️ 해당 없음 ${back.length.toLocaleString()}개 받은편지함으로 복원`);
          }
          consecutiveMoveFails = 0;
        } catch (moveErr) {
          if (Array.isArray(moveErr.partial)) { moveErr.partial.forEach((u) => seen.add(u)); restoredEarly += moveErr.partial.length; }
          else if (moveErr.partial) totalMoved += recordMoves(moveErr.partial, { subjects, seen, catTotals, CATEGORIES, log });
          log('error', `  ⚠️ MOVE 실패: ${moveErr.message}`);
          consecutiveMoveFails++;
          if (consecutiveMoveFails >= 3) {
            log('error', '  ⚠️ 이동이 3회 연속 실패 — 분류를 멈추고 복원 단계로 넘어갑니다');
            break;
          }
          await safeReconnect();
          continue;
        }
      }

      } // end if (tempHasEmails) — Phase 2
    } finally {
      if (tempHasEmails) {
      log('info', '\n📬 임시 보관 메일 받은편지함으로 복원 중...');
      try {
        if (!client.usable) await safeReconnect();
        let restored;
        try {
          restored = await client.searchAndMoveAll(TEMP_FOLDER, 'INBOX', 200);
        } catch (err) {
          log('error', `  복원 1차 실패: ${err.message}`);
          await safeReconnect();
          restored = await client.searchAndMoveAll(TEMP_FOLDER, 'INBOX', 200);
        }
        const restoredTotal = restoredEarly + restored;
        if (restoredTotal > 0) {
          log('info', `  ↩️ 분류 대상이 아닌 메일 총 ${restoredTotal.toLocaleString()}개 받은편지함으로 복원 완료`);
          logger.info('CATEGORIZE', `[${provider}] 받은편지함 복원 완료 — ${restoredTotal}개`);
        } else {
          log('info', `  복원할 미분류 메일 없음`);
        }
        // IMAP DELETE는 폴더 안의 메일까지 지우므로, 새 연결로 확인해 비어 있을 때만 폴더를 지운다
        await safeReconnect();
        const left = await client.countMessages(TEMP_FOLDER);
        if (left === 0) {
          await client.deleteFolder(TEMP_FOLDER);
          log('info', `  🧹 임시 폴더(${TEMP_FOLDER}) 삭제`);
        } else {
          log('warn', `  ⚠️ '${TEMP_FOLDER}'에 ${left.toLocaleString()}통이 남아 폴더를 지우지 않았습니다 (메일은 보존됨)`);
        }
      } catch (err) {
        log('error', `  ⚠️ 복원 실패: ${err.message}`);
        log('error', `  '${TEMP_FOLDER}' 폴더에 메일이 남아있을 수 있습니다. Nate 웹메일에서 확인해주세요.`);
        logger.error('CATEGORIZE', `[${provider}] 복원 실패: ${err.message}`);
      }
      } // end if (tempHasEmails)
    }

    // ── 안전망: 이동 중 연결이 끊겨 "복사는 됐는데 원본 삭제가 안 된" 중복이
    // 생겼을 수 있어, 완료 처리 전에 항상 전체 폴더를 훑어 자동으로 정리한다.
    log('info', '\n🔍 이동 중 생겼을 수 있는 중복 메일 확인 중...');
    try {
      // 연결이 끊겨 "복사는 됐는데 원본은 삭제 표시만 된" 메일은 표시를 해제해 일반 메일로 되돌린다
      // (메일은 보존됨) — 그래야 아래 중복 정리가 이것까지 정상적인 중복으로 보고 한 통만 남긴다
      await safeReconnect();
      const foldersNow = await client.listFolders();
      for (const f of ['INBOX', TEMP_FOLDER].filter((f) => f === 'INBOX' || foldersNow.includes(f))) {
        const n = await client.clearDeletedFlags(f);
        if (n) log('info', `  "${f}" 이동 중 남은 삭제 표시 ${n}통 해제 (메일은 보존)`);
      }
      await safeReconnect();
      const { deleted, planned } = await scanAndDedupe(client, (level, msg) => log(level, `  ${msg}`));
      if (deleted) log('success', `  ✅ 중복 ${deleted.toLocaleString()}통 자동 정리 완료`);
      else if (planned) log('warn', `  ⚠️ 중복 ${planned.toLocaleString()}통 발견했지만 일부만 정리됨 — '중복 메일 찾기'로 다시 확인해주세요`);
    } catch (err) {
      log('error', `  ⚠️ 중복 확인 실패: ${err.message} — '중복 메일 찾기'를 별도로 실행해주세요`);
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

// ── GET /api/mail/:provider/find-duplicates  (SSE, 읽기전용) ──────
// 계정 전체 폴더를 읽기만 하고 Message-ID 기준으로 중복(같은 메일이 여러 폴더/같은 폴더에
// 두 번 이상 존재)을 찾아 파일로 저장한다. 이동·삭제는 절대 하지 않는다.
router.get('/:provider/find-duplicates', requireAuth, async (req, res) => {
  const { provider } = req.params;
  if (!['nate', 'naver'].includes(provider)) {
    return res.status(400).json({ error: 'IMAP 프로바이더(nate/naver)만 지원합니다' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  function log(level, msg)   { logger[level]('DUPCHECK', msg); send('log', { message: msg, level }); }

  let client;
  try {
    client = await buildClient(provider, req.session.providers[provider]);
    const { totalScanned, dupGroups } = await scanAllFoldersForDuplicates(client, log);
    const dupTotal = dupGroups.reduce((s, g) => s + g.count, 0);

    const fs   = require('fs');
    const path = require('path');
    const dir  = path.join(__dirname, '..', '..', '..', 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `duplicates-${provider}-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({ scannedAt: new Date().toISOString(), totalScanned, dupGroups }, null, 2), 'utf8');

    log('success', `✅ 전체 ${totalScanned.toLocaleString()}통 스캔 완료 — 중복 그룹 ${dupGroups.length}개 (메일 ${dupTotal}통)`);
    logger.success('DUPCHECK', `[${provider}] 중복 스캔 완료 → ${file}`);
    send('complete', { total: totalScanned, dupGroups: dupGroups.length, dupTotal, file });
  } catch (err) {
    logger.error('DUPCHECK', `[${provider}] 중복 스캔 오류: ${err.message}`);
    send('error', { message: err.message });
  } finally {
    if (client?.disconnect) await client.disconnect().catch(() => {});
    res.end();
  }
});

// ── GET /api/mail/:provider/dedupe  (SSE) ─────────────────────────
// find-duplicates가 저장한 최신 리포트를 읽어 그룹당 1통(가능하면 INBOX 사본)만 남기고
// 나머지를 삭제한다. 폴더별로 이미 \Deleted 표시된 메일이 있으면 그 폴더는 안전을 위해 건너뛴다.
router.get('/:provider/dedupe', requireAuth, async (req, res) => {
  const { provider } = req.params;
  if (!['nate', 'naver'].includes(provider)) {
    return res.status(400).json({ error: 'IMAP 프로바이더(nate/naver)만 지원합니다' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  function log(level, msg)   { logger[level]('DEDUPE', msg); send('log', { message: msg, level }); }

  const fs   = require('fs');
  const path = require('path');
  const dir  = path.join(__dirname, '..', '..', '..', 'data');

  let client;
  try {
    const reportFiles = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.startsWith(`duplicates-${provider}-`) && f.endsWith('.json')).sort()
      : [];
    if (!reportFiles.length) {
      throw new Error("저장된 중복 스캔 결과가 없습니다. '중복 메일 찾기'를 먼저 실행해주세요.");
    }
    const reportPath = path.join(dir, reportFiles[reportFiles.length - 1]);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    log('info', `📄 리포트 사용: ${reportFiles[reportFiles.length - 1]} (스캔 시각 ${report.scannedAt})`);

    client = await buildClient(provider, req.session.providers[provider]);
    const { deleted, planned } = await dedupeGroups(client, report.dupGroups, log);

    log('success', `✅ 총 ${deleted.toLocaleString()}통 삭제 완료 (계획 대비 ${planned.toLocaleString()}통)`);
    logger.success('DEDUPE', `[${provider}] 중복 삭제 완료 — ${deleted}개`);
    send('complete', { deleted, planned });
  } catch (err) {
    logger.error('DEDUPE', `[${provider}] 중복 삭제 오류: ${err.message}`);
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
