const { ImapFlow } = require('imapflow');

const DEFAULT_FOLDERS = {
  INBOX: 'INBOX',
  TRASH: '휴지통',
  SPAM: '스팸메일함',
};

function encodeId(folder, uid) { return `${folder}||${uid}`; }

// ImapFlow가 날짜 파싱 실패 시 raw 문자열을 반환하는 경우 대응
function safeIso(d) {
  if (!d) return '';
  if (d instanceof Date) return d.toISOString();
  try { return new Date(d).toISOString(); } catch (_) { return String(d); }
}

function decodeId(id) {
  const sep = id.lastIndexOf('||');
  return { folder: id.slice(0, sep), uid: parseInt(id.slice(sep + 2), 10) };
}

function groupByFolder(encodedIds) {
  const groups = {};
  for (const id of encodedIds) {
    const { folder, uid } = decodeId(id);
    if (!groups[folder]) groups[folder] = [];
    groups[folder].push(uid);
  }
  return groups;
}

class ImapClient {
  constructor({ user, password }, { host, port, folders = {} }) {
    this._folders  = { ...DEFAULT_FOLDERS, ...folders };
    this._email    = user;
    this._imapOpts = {
      host, port, secure: true,
      auth: { user, pass: password },
      logger: false,
      tls: { rejectUnauthorized: false },
      socketTimeout: 60000,
    };
    this._createImap();
  }

  _createImap() {
    // IMAP_DEBUG=1 환경변수로 서버 응답 로깅 활성화 (비밀번호 포함 클라이언트 명령 제외)
    const debugLogger = process.env.IMAP_DEBUG === '1' ? {
      debug: ({ src, msg }) => {
        if (src === 'c' && /^[A-Z\d]+ (LOGIN|AUTHENTICATE)/i.test(msg)) return;
        process.stderr.write(`[IMAP-${src.toUpperCase()}] ${msg}\n`);
      },
      info:  ({ src, msg }) => process.stderr.write(`[IMAP-${src.toUpperCase()}] ${msg}\n`),
      warn:  ({ src, msg }) => process.stderr.write(`[IMAP-WARN] ${msg}\n`),
      error: ({ src, msg }) => process.stderr.write(`[IMAP-ERR] ${msg}\n`),
    } : false;

    this.imap = new ImapFlow({ ...this._imapOpts, logger: debugLogger });
    // 'error' 이벤트 미청취 시 Node 프로세스 전체 크래시 방지
    this.imap.on('error', () => {});
  }

  get folders() { return this._folders; }
  // ImapFlow 연결 사용 가능 여부 (Command failed 후 서버 BYE 감지에 사용)
  get usable()  { return !!this.imap.usable; }

  async connect()    { await this.imap.connect(); }
  async disconnect() { try { await this.imap.logout(); } catch (_) {} }
  async getProfile() { return { emailAddress: this._email }; }

  // 연결이 끊어진 경우 ImapFlow 인스턴스를 재생성하여 재연결
  // close()로 TCP 소켓을 즉시 종료 → Nate가 중복 세션으로 거부하는 문제 방지
  async reconnect() {
    try { await this.imap.logout(); } catch (_) {}
    try { this.imap.close();        } catch (_) {}
    await new Promise(r => setTimeout(r, 2000)); // Nate 서버 세션 정리 대기
    this._createImap();
    await this.imap.connect();
  }

  async listFolders() {
    const list = await this.imap.list();
    return list.map((f) => f.path);
  }

  async renameMailbox(oldPath, newPath) {
    return this.imap.mailboxRename(oldPath, newPath);
  }

  async searchInFolder(folder, criteria, limit = 5000) {
    const lock = await this.imap.getMailboxLock(folder, { readOnly: true });
    try {
      const uids = await this.imap.search(criteria, { uid: true });
      return uids.slice(-limit).reverse()
        .map((uid) => ({ id: encodeId(folder, uid), uid, folder }));
    } finally { lock.release(); }
  }

  // 폴더 내 전체 메시지를 대상 폴더로 이동 — Nate 등 1000개 슬라이딩 윈도우 서버 대응
  // 패스마다 락을 재취득: UID SEARCH ALL로 현재 창의 UID를 얻고 이동, 빈 폴더가 될 때까지 반복
  async searchAndMoveAll(sourceFolder, targetFolder, chunkSize = 50, onProgress) {
    let totalMoved    = 0;
    let targetCreated = false;
    let failStreak    = 0;

    for (let pass = 0; pass < 500; pass++) {
      // 연결이 죽어있으면 재연결
      if (!this.usable) {
        try { await this.reconnect(); }
        catch (_) { break; }
      }

      // ── lock 획득 ──
      let lock;
      try {
        lock = await this.imap.getMailboxLock(sourceFolder);
      } catch (_) {
        if (!this.usable) {
          try { await this.reconnect(); } catch (_2) { break; }
          failStreak++;
          if (failStreak > 5) break;
          pass--; continue; // 같은 패스 재시도
        }
        break; // 폴더 없음 등 → 정상 종료
      }

      // ── SEARCH ──
      let uids = [];
      try {
        uids = await this.imap.search({ all: true }, { uid: true });
      } catch (_) {
        try { lock.release(); } catch (_2) {}
        if (!this.usable) {
          try { await this.reconnect(); } catch (_2) { break; }
          failStreak++;
          if (failStreak > 5) break;
          pass--; continue;
        }
        break;
      }

      if (!uids.length) {
        try { lock.release(); } catch (_) {}
        break; // 폴더 비어있음 → 완료
      }

      // ── MOVE (chunk 단위) ──
      let connLost = false;
      let movedInPass = 0;
      for (let i = 0; i < uids.length; i += chunkSize) {
        if (!this.usable) { connLost = true; break; }
        const chunk = uids.slice(i, i + chunkSize);
        try {
          await this.imap.messageMove(chunk, targetFolder, { uid: true });
        } catch (moveErr) {
          if (!this.usable) { connLost = true; break; }
          const m = `${moveErr.message || ''} ${moveErr.responseText || ''}`.toLowerCase();
          if (!targetCreated && (m.includes('trycreate') || m.includes('nonexist') || m.includes('no such'))) {
            try {
              await this.imap.mailboxCreate(targetFolder);
              try { await this.imap.mailboxSubscribe(targetFolder); } catch (_2) {}
              targetCreated = true;
              await this.imap.messageMove(chunk, targetFolder, { uid: true });
            } catch (_) { connLost = !this.usable; break; }
          } else {
            break; // 알 수 없는 에러 → 이 패스 중단, 다음 패스에서 재시도
          }
        }
        movedInPass += chunk.length;
        totalMoved  += chunk.length;
        if (onProgress) onProgress(totalMoved);
      }

      try { lock.release(); } catch (_) {}

      if (connLost) {
        try { await this.reconnect(); } catch (_) { break; }
        failStreak++;
        if (failStreak > 5) break;
        pass--; continue; // 같은 패스 재시도 (이미 이동된 건 서버에 반영됨)
      }

      failStreak = 0;
      if (movedInPass === 0) break; // 이번 패스에서 아무것도 못 이동 → 완료
    }
    return totalMoved;
  }

  async getMetadata(encodedIds) {
    if (!encodedIds.length) return [];
    const results = [];
    const CHUNK = 100; // IMAP 명령 길이 제한 우회 (Nate 등 구형 서버 호환)

    for (const [folder, uids] of Object.entries(groupByFolder(encodedIds))) {
      const lock = await this.imap.getMailboxLock(folder, { readOnly: true });
      try {
        for (let i = 0; i < uids.length; i += CHUNK) {
          const chunk = uids.slice(i, i + CHUNK);
          for await (const msg of this.imap.fetch(chunk, { envelope: true }, { uid: true })) {
            const f = msg.envelope.from?.[0];
            const fromStr = f ? (f.name ? `${f.name} <${f.address}>` : f.address) : '';
            results.push({
              id: encodeId(folder, msg.uid), uid: msg.uid, folder,
              payload: { headers: [
                { name: 'Subject', value: msg.envelope.subject || '' },
                { name: 'From',    value: fromStr },
                { name: 'Date',    value: safeIso(msg.envelope.date) || '' },
              ]},
            });
          }
        }
      } finally { lock.release(); }
    }
    return results;
  }

  // 폴더 전체 메시지 메타데이터 조회
  // SELECT 단일 잠금으로 SEARCH ALL + FETCH를 한 번에 처리
  // → 잠금 반복 취득/해제 시 Nate가 EXAMINE→SELECT 전환에 BYE를 보내는 문제 방지
  async fetchAllMetadata(folder, onProgress) {
    const CHUNK   = 500;
    const results = [];

    const lock = await this.imap.getMailboxLock(folder); // SELECT (단일 잠금)
    try {
      const allUids = await this.imap.search({ all: true }, { uid: true });
      if (!allUids.length) { if (onProgress) onProgress(0, 0); return results; }

      // 청크로 나눠 FETCH — UID 목록이 비연속적이면 단일 FETCH 명령어가 너무 길어져 Nate가 거부
      for (let i = 0; i < allUids.length; i += CHUNK) {
        const chunk = allUids.slice(i, i + CHUNK);
        for await (const msg of this.imap.fetch(chunk, { envelope: true }, { uid: true })) {
          if (!msg.envelope || !msg.uid) continue;
          const f = msg.envelope.from?.[0];
          const fromStr = f ? (f.name ? `${f.name} <${f.address}>` : f.address) : '';
          results.push({
            id: encodeId(folder, msg.uid), uid: msg.uid, folder,
            payload: { headers: [
              { name: 'Subject', value: msg.envelope.subject || '' },
              { name: 'From',    value: fromStr },
              { name: 'Date',    value: safeIso(msg.envelope.date) || '' },
            ]},
          });
        }
        if (onProgress) onProgress(Math.min(i + CHUNK, allUids.length), allUids.length);
      }
    } finally { lock.release(); }

    return results;
  }

  async trashMessages(ids)  { return this._moveTo(ids, this._folders.TRASH); }
  async markAsSpam(ids)     { return this._moveTo(ids, this._folders.SPAM);  }
  async moveTo(ids, folder) { return this._moveTo(ids, folder); }

  // 받은편지함 단일 배치 처리
  // Nate는 세션당 FETCH 명령 2회 이후 BYE를 전송함 → MOVE가 "Connection not available"로 실패
  // 해결: 청크(50개)마다 fresh 연결을 사용해 세션당 FETCH를 1회로 제한
  //   Step 1) EXAMINE(읽기 전용) + SEARCH — UID 목록만 수집, FETCH 없음 → BYE 없음
  //   Step 2) 청크마다: reconnect → SELECT → FETCH 50 → 즉시 MOVE (세션당 FETCH 1회)
  async processInboxBatch(matchFn, tempFolder, onProgress) {
    const CHUNK     = 50;
    const catUids   = {}; // folderKey → [uid, ...]
    let   tempCount = 0;

    // Step 1: UID 목록 수집 (FETCH 없음 → BYE 위험 없음)
    let allUids;
    {
      const lock = await this.imap.getMailboxLock('INBOX', { readOnly: true });
      try {
        allUids = await this.imap.search({ all: true }, { uid: true });
      } finally {
        lock.release();
      }
    }
    if (!allUids.length) return { catUids: {}, tempCount: 0, total: 0 };
    const total = allUids.length;

    const catCreated  = {};
    let   tempCreated = false;

    // Step 2: 청크마다 fresh 연결 → FETCH 50 → 즉시 MOVE (세션당 FETCH 1회 → BYE 없음)
    for (let i = 0; i < allUids.length; i += CHUNK) {
      await this.reconnect(); // 새 연결: SELECT + FETCH 1회만 사용, BYE 트리거 안 됨

      const uidChunk   = allUids.slice(i, i + CHUNK);
      const toCategory = {};
      const toTemp     = [];

      const lock = await this.imap.getMailboxLock('INBOX');
      try {
        for await (const msg of this.imap.fetch(uidChunk, { envelope: true }, { uid: true })) {
          if (!msg.envelope || !msg.uid) continue;
          const f       = msg.envelope.from?.[0];
          const fromStr = f ? (f.name ? `${f.name} <${f.address}>` : f.address) : '';
          const target  = matchFn(msg.envelope.subject || '', fromStr);
          if (target) {
            if (!toCategory[target]) toCategory[target] = [];
            toCategory[target].push(msg.uid);
            if (!catUids[target]) catUids[target] = [];
            catUids[target].push(msg.uid);
          } else {
            toTemp.push(msg.uid);
          }
        }

        for (const [folder, uids] of Object.entries(toCategory)) {
          try {
            await this.imap.messageMove(uids, folder, { uid: true });
          } catch (moveErr) {
            const m = `${moveErr.message || ''} ${moveErr.responseText || ''}`.toLowerCase();
            if (!catCreated[folder] && (m.includes('trycreate') || m.includes('nonexist') || m.includes('no such'))) {
              await this.imap.mailboxCreate(folder);
              catCreated[folder] = true;
              await this.imap.messageMove(uids, folder, { uid: true });
            } else throw moveErr;
          }
        }

        if (toTemp.length) {
          try {
            await this.imap.messageMove(toTemp, tempFolder, { uid: true });
          } catch (moveErr) {
            const m = `${moveErr.message || ''} ${moveErr.responseText || ''}`.toLowerCase();
            if (!tempCreated && (m.includes('trycreate') || m.includes('nonexist') || m.includes('no such'))) {
              await this.imap.mailboxCreate(tempFolder);
              tempCreated = true;
              await this.imap.messageMove(toTemp, tempFolder, { uid: true });
            } else throw moveErr;
          }
          tempCount += toTemp.length;
        }
      } finally {
        lock.release();
      }

      if (onProgress) onProgress(Math.min(i + CHUNK, allUids.length), allUids.length);
    }

    return { catUids, tempCount, total };
  }

  // Phase 1: INBOX → tempFolder, SEARCH/FETCH 없이 시퀀스 번호 MOVE만 사용
  // Nate는 UIDPLUS MOVE를 사용해 EXPUNGE가 오지 않아 mailbox.exists가 stale 유지됨
  // → messageMove 반환값의 uidMap.size로 실제 이동 수 확인
  async drainInboxToTemp(tempFolder, onProgress) {
    let totalMoved      = 0;
    let tempCreated     = false;
    let consecutiveFails = 0;
    let staleRetried    = false; // Nate stale EXISTS=0 재시도 플래그 (최대 1회)
    const MAX_PASSES    = 300;
    const MAX_FAILS     = 10;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      try {
        if (!this.usable) await this.reconnect();

        const lock = await this.imap.getMailboxLock('INBOX');
        let moveResult;
        let before = 0;
        try {
          before = this.imap.mailbox.exists;
          // EXISTS=0이더라도 Nate는 stale값을 반환할 수 있음 → 항상 MOVE 시도 후 uidMap으로 판단
          try {
            moveResult = await this.imap.messageMove('1:*', tempFolder);
          } catch (err) {
            const m = (err.message || '').toLowerCase();
            const r = (err.responseText || '').toLowerCase();
            process.stderr.write(`[drainInboxToTemp] MOVE error: ${err.message} | response: ${err.responseText || ''}\n`);
            if (!tempCreated && (m.includes('trycreate') || r.includes('trycreate') ||
                m.includes('nonexist') || r.includes('nonexist') ||
                m.includes('no such')  || r.includes('no such')  ||
                m.includes('invalid')  || r.includes('invalid'))) {
              process.stderr.write(`[drainInboxToTemp] Creating folder: ${tempFolder}\n`);
              await this.imap.mailboxCreate(tempFolder);
              tempCreated = true;
              moveResult = await this.imap.messageMove('1:*', tempFolder);
            } else throw err;
          }

          // moveResult === false: resolveRange가 false 반환 (mailbox가 비어있음을 이미 알고있음)
          // moveResult.uidMap.size === 0: UIDPLUS MOVE에서 아무것도 이동 안됨 → INBOX 비어있음
          const movedCount = moveResult === false ? 0 : (moveResult?.uidMap?.size ?? null);
          if (movedCount === 0) {
            lock.release();
            // Nate stale EXISTS 감지: STATUS로 실제 메일 수 확인 후 1회 재연결
            if (!staleRetried) {
              staleRetried = true;
              try {
                const st = await this.imap.status('INBOX', { messages: true });
                if ((st.messages ?? 0) > 0) {
                  await this.reconnect();
                  pass--; // for 루프 pass++ 후 동일 pass 재실행
                  continue;
                }
              } catch (_) {}
            }
            break;
          }

          totalMoved += movedCount ?? before; // UIDPLUS: 정확한 수, 아니면 SELECT 시점의 수
          if (onProgress) onProgress(totalMoved);
          consecutiveFails = 0;
        } finally {
          try { lock.release(); } catch (_) {}
        }

        // UIDPLUS 미지원 폴백: 락 해제 후 재SELECT로 INBOX 잔여 수 확인
        if (moveResult !== false && moveResult?.uidMap == null) {
          const checkLock = await this.imap.getMailboxLock('INBOX');
          try {
            if (this.imap.mailbox.exists === 0) { checkLock.release(); break; }
          } finally {
            try { checkLock.release(); } catch (_) {}
          }
        }

        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        process.stderr.write(`[drainInboxToTemp] pass=${pass} outer error: ${err.message}\n`);
        consecutiveFails++;
        if (consecutiveFails > MAX_FAILS) break;
        await new Promise(r => setTimeout(r, 1000));
        try { await this.reconnect(); } catch (_) {}
        pass--;
      }
    }
    return totalMoved;
  }

  // 폴더 메일 수 반환 (TEMP 잔여 메일 확인용)
  async getMailboxExists(folder) {
    const lock = await this.imap.getMailboxLock(folder);
    try {
      return this.imap.mailbox.exists;
    } finally {
      lock.release();
    }
  }

  // Phase 2: TEMP 폴더에서 FETCH → JavaScript matchFn으로 분류 → MOVE
  // SEARCH 대신 FETCH 사용 (Nate SEARCH는 한국어 리터럴에서 Command failed)
  // FETCH가 non-INBOX에서도 BYE를 트리거하는 경우 대비: buckets 반환 후 caller가 reconnect+MOVE
  async fetchFolderClassified(folder, matchFn, onProgress) {
    const buckets = {};
    let total      = 0;
    let fetchError = null;

    const lock = await this.imap.getMailboxLock(folder);
    try {
      for await (const msg of this.imap.fetch('1:*', { envelope: true }, { uid: true })) {
        if (!msg.envelope || !msg.uid) continue;
        total++;
        const f       = msg.envelope.from?.[0];
        const fromStr = f ? (f.name ? `${f.name} <${f.address}>` : f.address) : '';
        const target  = matchFn(msg.envelope.subject || '', fromStr);
        if (target) {
          if (!buckets[target]) buckets[target] = [];
          buckets[target].push(msg.uid);
        }
        if (onProgress) onProgress(total);
      }
    } catch (err) {
      fetchError = err;
      // 연결 끊김이어도 지금까지 수집한 buckets는 유효
    } finally {
      try { lock.release(); } catch (_) {}
    }
    return { buckets, total, error: fetchError };
  }

  // TEMP 폴더에서 카테고리별로 분류된 UID를 각 카테고리 폴더로 MOVE
  // 미분류 메일은 TEMP에 그대로 남김 (나중에 searchAndMoveAll로 INBOX 복원)
  async moveCategorizedFromFolder(folder, buckets) {
    const CHUNK  = 50;
    const result = { catMoved: {} };
    const catCreated = {};

    const entries = Object.entries(buckets).filter(([, uids]) => uids.length > 0);
    if (!entries.length) return result;

    if (!this.usable) await this.reconnect();
    const lock = await this.imap.getMailboxLock(folder);
    try {
      for (const [targetFolder, uids] of entries) {
        for (let i = 0; i < uids.length; i += CHUNK) {
          const chunk = uids.slice(i, i + CHUNK);
          try {
            await this.imap.messageMove(chunk, targetFolder, { uid: true });
          } catch (err) {
            const m = `${err.message || ''} ${err.responseText || ''}`.toLowerCase();
            if (!catCreated[targetFolder] && (m.includes('trycreate') || m.includes('nonexist') || m.includes('no such'))) {
              await this.imap.mailboxCreate(targetFolder);
              catCreated[targetFolder] = true;
              await this.imap.messageMove(chunk, targetFolder, { uid: true });
            } else throw err;
          }
          result.catMoved[targetFolder] = (result.catMoved[targetFolder] || 0) + chunk.length;
        }
      }
    } finally {
      lock.release();
    }
    return result;
  }

  // FETCH 전용 — UID + 분류 결과를 메모리에 수집
  // Nate는 FETCH 완료 후 BYE를 보냄 → 이 메서드 호출 후 연결이 죽어있음
  async fetchInboxClassified(matchFn, onProgress) {
    const buckets  = {};
    const tempUids = [];
    let   total    = 0;

    const lock = await this.imap.getMailboxLock('INBOX');
    try {
      for await (const msg of this.imap.fetch('1:*', { envelope: true }, { uid: true })) {
        if (!msg.envelope || !msg.uid) continue;
        total++;
        const f       = msg.envelope.from?.[0];
        const fromStr = f ? (f.name ? `${f.name} <${f.address}>` : f.address) : '';
        const target  = matchFn(msg.envelope.subject || '', fromStr);
        if (target) {
          if (!buckets[target]) buckets[target] = [];
          buckets[target].push(msg.uid);
        } else {
          tempUids.push(msg.uid);
        }
      }
    } finally {
      lock.release();
    }

    if (onProgress) onProgress(total);
    return { buckets, tempUids, total };
  }

  // MOVE 전용 — fetchInboxClassified가 수집한 데이터를 이동
  // reconnect() 후 새 연결에서 호출해야 함
  async moveClassified(buckets, tempUids, tempFolder) {
    const CHUNK      = 50;
    const result     = { catMoved: {}, tempMoved: 0 };
    const catCreated = {};
    let   tempCreated = false;

    const lock = await this.imap.getMailboxLock('INBOX');
    try {
      for (const [folder, uids] of Object.entries(buckets)) {
        for (let i = 0; i < uids.length; i += CHUNK) {
          const chunk = uids.slice(i, i + CHUNK);
          try {
            await this.imap.messageMove(chunk, folder, { uid: true });
          } catch (err) {
            const m = `${err.message || ''} ${err.responseText || ''}`.toLowerCase();
            if (!catCreated[folder] && (m.includes('trycreate') || m.includes('nonexist') || m.includes('no such'))) {
              await this.imap.mailboxCreate(folder);
              catCreated[folder] = true;
              await this.imap.messageMove(chunk, folder, { uid: true });
            } else throw err;
          }
          result.catMoved[folder] = (result.catMoved[folder] || 0) + chunk.length;
        }
      }

      for (let i = 0; i < tempUids.length; i += CHUNK) {
        const chunk = tempUids.slice(i, i + CHUNK);
        try {
          await this.imap.messageMove(chunk, tempFolder, { uid: true });
        } catch (err) {
          const m = `${err.message || ''} ${err.responseText || ''}`.toLowerCase();
          if (!tempCreated && (m.includes('trycreate') || m.includes('nonexist') || m.includes('no such'))) {
            await this.imap.mailboxCreate(tempFolder);
            tempCreated = true;
            await this.imap.messageMove(chunk, tempFolder, { uid: true });
          } else throw err;
        }
        result.tempMoved += chunk.length;
      }
    } finally {
      lock.release();
    }

    return result;
  }

  async moveToWithCreate(encodedIds, targetFolder) {
    const CHUNK = 50;
    let count = 0;
    for (const [folder, uids] of Object.entries(groupByFolder(encodedIds))) {
      if (folder === targetFolder) { count += uids.length; continue; }
      const lock = await this.imap.getMailboxLock(folder);
      try {
        let targetCreated = false;
        for (let i = 0; i < uids.length; i += CHUNK) {
          const chunk = uids.slice(i, i + CHUNK);
          try {
            await this.imap.messageMove(chunk, targetFolder, { uid: true });
          } catch (moveErr) {
            const m = `${moveErr.message || ''} ${moveErr.responseText || ''}`.toLowerCase();
            if (!targetCreated && (m.includes('trycreate') || m.includes('nonexist') || m.includes('no such'))) {
              await this.imap.mailboxCreate(targetFolder);
              targetCreated = true;
              await this.imap.messageMove(chunk, targetFolder, { uid: true });
            } else throw moveErr;
          }
          count += chunk.length;
        }
      } finally { lock.release(); }
    }
    return count;
  }

  async deleteMessages(encodedIds) {
    let count = 0;
    for (const [folder, uids] of Object.entries(groupByFolder(encodedIds))) {
      const lock = await this.imap.getMailboxLock(folder);
      try { await this.imap.messageDelete(uids, { uid: true }); count += uids.length; }
      finally { lock.release(); }
    }
    return count;
  }

  async createBlockFilter() {
    throw new Error('IMAP은 서버 사이드 발신자 차단 필터를 지원하지 않습니다.\n메일 서비스 웹에서 직접 수신차단 설정을 사용해주세요.');
  }

  async createFolder(name) {
    try { await this.imap.mailboxCreate(name); }
    catch (err) {
      const msg = `${err.message || ''} ${err.responseText || ''}`.toLowerCase();
      // 표준(RFC 5530) [ALREADYEXISTS] 및 서버별 변형 응답 처리
      const isExisting =
        msg.includes('already exist') || msg.includes('alreadyexist') ||
        msg.includes('mailboxexist')  || msg.includes('mailbox exists') ||
        msg.includes('duplicate')     ||
        msg.includes('already created') || msg.includes('exists already');
      if (!isExisting) throw err;
    }
  }

  async deleteFolder(path) {
    try { await this.imap.mailboxDelete(path); }
    catch (err) {
      const msg = `${err.message || ''} ${err.responseText || ''}`.toLowerCase();
      if (!msg.includes('nonexistent') && !msg.includes('does not exist') && !msg.includes('no such')) throw err;
    }
  }

  async _moveTo(encodedIds, targetFolder) {
    const CHUNK = 50;
    let count = 0;
    for (const [folder, uids] of Object.entries(groupByFolder(encodedIds))) {
      if (folder === targetFolder) { count += uids.length; continue; }
      // 폴더당 단일 잠금 — 청크마다 재취득 시 Nate가 BYE를 보내는 문제 방지
      const lock = await this.imap.getMailboxLock(folder);
      try {
        for (let i = 0; i < uids.length; i += CHUNK) {
          const chunk = uids.slice(i, i + CHUNK);
          await this.imap.messageMove(chunk, targetFolder, { uid: true });
          count += chunk.length;
        }
      } finally { lock.release(); }
    }
    return count;
  }
}

module.exports = { ImapClient };
