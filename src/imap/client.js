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
  async reconnect() {
    try { await this.imap.logout(); } catch (_) {}
    this._createImap();
    await this.imap.connect();
  }

  async listFolders() {
    const list = await this.imap.list();
    return list.map((f) => f.path);
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
  async searchAndMoveAll(sourceFolder, targetFolder, chunkSize = 50) {
    let totalMoved = 0;
    for (let pass = 0; pass < 500; pass++) {
      let lock;
      try { lock = await this.imap.getMailboxLock(sourceFolder); }
      catch (_) { break; } // 폴더 없음(정상 종료) 또는 연결 끊김

      let movedInPass = 0;
      try {
        const uids = await this.imap.search({ all: true }, { uid: true });
        for (let i = 0; i < uids.length; i += chunkSize) {
          const chunk = uids.slice(i, i + chunkSize);
          try {
            await this.imap.messageMove(chunk, targetFolder, { uid: true });
          } catch (moveErr) {
            const m = `${moveErr.message || ''} ${moveErr.responseText || ''}`.toLowerCase();
            if (m.includes('trycreate') || m.includes('nonexist') || m.includes('no such')) {
              await this.imap.mailboxCreate(targetFolder);
              await this.imap.messageMove(chunk, targetFolder, { uid: true });
            } else throw moveErr;
          }
          movedInPass += chunk.length;
        }
        totalMoved += movedInPass;
      } finally { lock.release(); }

      if (movedInPass === 0) break; // 폴더 비어있음 → 완료
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

  async moveToWithCreate(encodedIds, targetFolder) {
    return this._moveTo(encodedIds, targetFolder);
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
