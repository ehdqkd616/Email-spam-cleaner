const { ImapFlow } = require('imapflow');
const logger = require('../logger');

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

// 검색 조건에 비-ASCII(한글 등) 문자열이 있는지 재귀 확인
// — 일부 IMAP 서버(Nate 등)가 CHARSET UTF-8 SEARCH의 한글 literal을
//   제대로 처리하지 못해 오류 없이 0건을 반환하는 문제 감지용
function hasUnicodeValue(value) {
  if (value == null) return false;
  if (typeof value === 'string') return /[^\x00-\x7F]/.test(value);
  if (Array.isArray(value)) return value.some(hasUnicodeValue);
  if (typeof value === 'object') return Object.values(value).some(hasUnicodeValue);
  return false;
}

// searchInFolder의 criteria 객체를 클라이언트에서 직접 평가 (FETCH 기반 대체 경로용)
function matchesCriteria(criteria, envelope, flags) {
  return Object.entries(criteria).every(([key, value]) => {
    switch (key) {
      case 'or':
        return value.some((cond) => matchesCriteria(cond, envelope, flags));
      case 'subject': {
        const subject = (envelope.subject || '').toLowerCase();
        return subject.includes(String(value).toLowerCase());
      }
      case 'from': {
        const f = envelope.from?.[0];
        const fromStr = f ? `${f.name || ''} ${f.address || ''}`.toLowerCase() : '';
        return fromStr.includes(String(value).toLowerCase());
      }
      case 'seen':
        return (flags || new Set()).has('\\Seen') === value;
      case 'before':
        return !!envelope.date && new Date(envelope.date) < value;
      case 'since':
        return !!envelope.date && new Date(envelope.date) >= value;
      default:
        return true;
    }
  });
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
    // IMAP_DEBUG=1 환경변수로 서버 응답 로깅 활성화 (로그인 명령·인증 데이터 줄은 제외)
    // ImapFlow는 src/msg가 없는 로그(소켓 타임아웃 등)도 보내므로, 어떤 형식이 와도 예외를 내지 않아야 한다
    // — 예전에는 여기서 난 TypeError가 타이머 안에서 터져 서버 프로세스가 통째로 죽었다(502의 원인).
    const write = (tag, e) => {
      try {
        const entry = e && typeof e === 'object' ? e : { msg: String(e) };
        const text  = entry.msg ?? entry.err?.message ?? '';
        if (entry.src === 'c' && (/^[A-Z\d]+ (LOGIN|AUTHENTICATE)/i.test(text) || /^[A-Za-z0-9+/=]{16,}$/.test(text))) return;
        process.stderr.write(`[IMAP-${tag || (entry.src ? String(entry.src).toUpperCase() : 'LOG')}] ${text}\n`);
      } catch (_) { /* 디버그 로그 때문에 서버가 죽으면 안 됨 */ }
    };
    const debugLogger = process.env.IMAP_DEBUG === '1' ? {
      debug: (e) => write(null, e),
      info:  (e) => write(null, e),
      warn:  (e) => write('WARN', e),
      error: (e) => write('ERR', e),
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
    // Nate 서버 세션 정리 대기 — 직후 재연결은 Unexpected close로 거부되는 일이 잦아
    // 대기 시간을 늘려가며 여러 번 시도한다
    const delays = [2000, 4000, 6000, 10000, 15000];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      await new Promise(r => setTimeout(r, delays[attempt]));
      this._createImap();
      try {
        await this.imap.connect();
        return;
      } catch (err) {
        try { this.imap.close(); } catch (_) {}
        if (attempt === delays.length - 1) throw err;
        logger.warn('SYSTEM', `[IMAP] 재연결 실패 (${attempt + 1}회): ${err.message} — 재시도`);
      }
    }
  }

  // Nate는 로그인 직후 "연결 성공" 응답을 보내고 나서 비동기로 연결을 끊는 경우가 있어,
  // connect() 직후 this.usable을 미리 확인해도 레이스 컨디션으로 놓칠 수 있다.
  // 그래서 사전 확인 대신 "일단 시도 → 실패하면 재연결 후 1회 재시도" 방식을 쓴다.
  async _withReconnectRetry(fn) {
    try {
      return await fn();
    } catch (err) {
      const msg = `${err.message || ''} ${err.responseText || ''}`.toLowerCase();
      const looksLikeDeadConnection =
        !this.usable || msg.includes('connection not available') || msg.includes('unexpected close');
      if (!looksLikeDeadConnection) throw err;
      logger.warn('SYSTEM', `[IMAP] 연결 끊김 감지(${err.message}) — 재연결 후 재시도`);
      await this.reconnect();
      try {
        return await fn();
      } catch (retryErr) {
        logger.error('SYSTEM', `[IMAP] 재연결 후에도 실패: ${retryErr.message}`);
        throw retryErr;
      }
    }
  }

  async listFolders() {
    const list = await this.imap.list();
    return list.map((f) => f.path);
  }

  // 폴더 하나를 전부 읽기전용으로 훑는다 (이동/삭제 없음). Nate가 폴더당 1000통만
  // 노출하므로, 1000통 꽉 찬 경우 보이는 최대 UID 뒤쪽을 이어서 읽어 전체를 확보한다.
  async scanFolderAllMessages(folder) {
    const lock = await this.imap.getMailboxLock(folder, { readOnly: true });
    const items = [];
    let maxUid = 0;
    try {
      for await (const msg of this.imap.fetch('1:*', { envelope: true }, { uid: true })) {
        if (!msg.envelope || !msg.uid) continue;
        if (msg.uid > maxUid) maxUid = msg.uid;
        items.push({
          uid: msg.uid,
          messageId: msg.envelope.messageId || '',
          subject: msg.envelope.subject || '',
          date: safeIso(msg.envelope.date),
          from: msg.envelope.from?.[0] ? (msg.envelope.from[0].name || msg.envelope.from[0].address) : '',
        });
      }
      if (items.length >= 1000) {
        let cursor = maxUid;
        for (let round = 0; round < 100; round++) {
          let got = 0;
          for await (const msg of this.imap.fetch(`${cursor + 1}:*`, { envelope: true }, { uid: true })) {
            if (!msg.envelope || !msg.uid || msg.uid <= cursor) continue;
            got++;
            if (msg.uid > maxUid) maxUid = msg.uid;
            items.push({
              uid: msg.uid,
              messageId: msg.envelope.messageId || '',
              subject: msg.envelope.subject || '',
              date: safeIso(msg.envelope.date),
              from: msg.envelope.from?.[0] ? (msg.envelope.from[0].name || msg.envelope.from[0].address) : '',
            });
          }
          if (!got || maxUid <= cursor) break;
          cursor = maxUid;
        }
      }
    } finally { lock.release(); }
    return items;
  }

  async renameMailbox(oldPath, newPath) {
    return this.imap.mailboxRename(oldPath, newPath);
  }

  // 서버 폴더 목록을 세션당 1회만 조회해 캐싱 (resolveFolder에서 반복 호출됨)
  async _getFolderList() {
    if (!this._folderListCache) {
      try { this._folderListCache = await this.listFolders(); }
      catch (err) {
        logger.error('SYSTEM', `[IMAP] 폴더 목록 조회 실패: ${err.message}`);
        this._folderListCache = [];
      }
    }
    return this._folderListCache;
  }

  // 개념은 같지만 글자가 아예 다른 폴더명 별칭 (예: 스팸 == 정크메일)
  // 계정/서비스 버전에 따라 실제 폴더명이 다를 수 있어 substring 매칭만으론 부족
  static FOLDER_ALIASES = {
    스팸: ['스팸', '정크', 'junk', 'spam'],
    광고: ['광고', 'ad', 'promo'],
    휴지통: ['휴지통', 'trash', 'deleted'],
  };

  // 설정된 폴더명이 실제 계정에 없을 때(같은 서비스라도 계정/버전별로
  // '스팸' / '스팸메일함' / '스팸함' / '정크 메일' 등 이름이 다른 경우) 유사한 실제 폴더로 대체
  async resolveFolder(folder) {
    if (folder === 'INBOX') return folder;
    const list = await this._getFolderList();
    if (list.includes(folder)) return folder;

    const core = folder.replace(/(메일함|편지함|함)$/, '') || folder;
    const aliases = ImapClient.FOLDER_ALIASES[core] || [core];
    const candidates = list.filter((f) => f !== 'INBOX' &&
      aliases.some((alias) => f.toLowerCase().includes(alias.toLowerCase())));
    if (candidates.length) {
      candidates.sort((a, b) => a.length - b.length);
      const resolved = candidates[0];
      logger.warn('SYSTEM', `[IMAP] 폴더 "${folder}"를 찾을 수 없어 "${resolved}"(으)로 대체`);
      return resolved;
    }
    // 대체 후보를 못 찾음 — 실제 서버 폴더 목록을 남겨 원인 파악
    logger.error('SYSTEM', `[IMAP] 폴더 "${folder}"를 찾을 수 없고 대체 후보도 없음. 서버 실제 폴더 목록: [${list.join(', ')}]`);
    return folder;
  }

  async searchInFolder(folder, criteria, limit = 5000) {
    const resolved = await this.resolveFolder(folder);

    // 한글 등 비-ASCII 검색어가 섞인 조건은 서버 SEARCH 대신 FETCH+클라이언트 매칭 사용
    // (일부 IMAP 서버가 CHARSET UTF-8 SEARCH의 한글 literal을 오류 없이 0건으로 반환함)
    if (hasUnicodeValue(criteria)) {
      return this._searchByFetch(resolved, criteria, limit);
    }

    const lock = await this.imap.getMailboxLock(resolved, { readOnly: true });
    try {
      const uids = await this.imap.search(criteria, { uid: true });
      return uids.slice(-limit).reverse()
        .map((uid) => ({ id: encodeId(resolved, uid), uid, folder: resolved }));
    } finally { lock.release(); }
  }

  async _searchByFetch(folder, criteria, limit) {
    const lock = await this.imap.getMailboxLock(folder, { readOnly: true });
    const matched = [];
    try {
      for await (const msg of this.imap.fetch('1:*', { envelope: true, flags: true }, { uid: true })) {
        if (!msg.envelope || !msg.uid) continue;
        if (matchesCriteria(criteria, msg.envelope, msg.flags)) {
          matched.push({ id: encodeId(folder, msg.uid), uid: msg.uid, folder });
        }
      }
    } finally { lock.release(); }
    return matched.slice(-limit).reverse();
  }

  // 받은편지함 전체를 matcher.js의 detectAd() 스코어링 엔진으로 판별
  // (기존 inboxKeywords는 13개 고정 키워드 substring만 확인해 [광고] 표기, 할인율,
  //  마케팅 발신 도메인 등 실제로 광고를 가장 잘 가려내는 신호를 전혀 못 씀 — 그래서
  //  "자동 분류"가 광고 제외용으로 이미 쓰고 있는 이 엔진을 스캔에도 그대로 재사용)
  //
  // bayesTrainConfig가 주어지면 계정에 이미 분류된 폴더(광고함 vs 결제·영수증 등)로
  // 학습한 나이브 베이즈 모델을 2차 판별기로 함께 사용 — 단, 규칙 기반이 이미 광고가
  // 아니라고 확정한(트랜잭션 보호) 메일은 베이즈 결과와 무관하게 항상 안전하게 유지한다.
  async scanInboxForAds(readFilter, limit = 5000, bayesTrainConfig = null) {
    const { detectAd, isShielded } = require('../matcher');
    const bayes = require('../bayes');

    let bayesModel = null;
    if (bayesTrainConfig) {
      const providerKey = this.constructor.name.replace(/Client$/, '').toLowerCase();
      try { bayesModel = await bayes.getOrTrainModel(providerKey, this, bayesTrainConfig); }
      catch (_) { /* 학습 실패해도 규칙 기반 판정은 계속 동작 */ }
    }

    // 다른 폴더 스캔은 resolveFolder()가 먼저 LIST를 날려 그 사이에 Nate의
    // "로그인 직후 첫 명령 즉시 끊기"가 소진되는데, INBOX는 이 워밍업이 없어 매번 그대로
    // 노출된다 — 동일하게 LIST를 한 번 태워 방어한다
    await this._getFolderList();

    const seenFilter = readFilter === 'is:unread' ? false : readFilter === 'is:read' ? true : null;
    const matched = await this._withReconnectRetry(async () => {
      const lock = await this.imap.getMailboxLock('INBOX', { readOnly: true });
      const found = [];
      try {
        for await (const msg of this.imap.fetch('1:*', { envelope: true, flags: true }, { uid: true })) {
          if (!msg.envelope || !msg.uid) continue;
          if (seenFilter !== null && !!msg.flags?.has('\\Seen') !== seenFilter) continue;
          const subject = msg.envelope.subject || '';
          const f       = msg.envelope.from?.[0];
          const from    = f ? (f.name ? `${f.name} <${f.address}>` : f.address) : '';

          let isAd = detectAd(subject, from).isAd;
          if (!isAd && bayesModel && !isShielded(subject)) {
            isAd = bayes.classify(bayesModel, `${subject} ${from}`).isAd;
          }
          if (isAd) {
            found.push({ id: encodeId('INBOX', msg.uid), uid: msg.uid, folder: 'INBOX' });
          }
        }
      } finally { lock.release(); }
      return found;
    });
    return matched.slice(-limit).reverse();
  }

  // 나이브 베이즈 학습용 — 폴더의 제목+발신자만 가볍게 수집. 없는 폴더는 조용히 스킵
  // (계정마다 카테고리 폴더를 다 만들어두지 않았을 수 있어 에러로 스캔 전체를 막으면 안 됨)
  // 폴더를 10여개 연달아 SELECT하면 Nate가 종종 BYE로 연결을 끊으므로,
  // 폴더마다 연결 상태를 확인하고 필요하면 재연결한 뒤 진행한다 — 여기서 연결이
  // 죽어도 절대 상위(scanInboxForAds의 본 스캔)로 전파되면 안 된다.
  async fetchTrainingTexts(folder, limit = 800) {
    try {
      return await this._withReconnectRetry(async () => {
        const lock = await this.imap.getMailboxLock(folder, { readOnly: true });
        const texts = [];
        try {
          const allUids = await this.imap.search({ all: true }, { uid: true });
          const uids = allUids.slice(-limit);
          if (uids.length) {
            for await (const msg of this.imap.fetch(uids, { envelope: true }, { uid: true })) {
              if (!msg.envelope) continue;
              const subject = msg.envelope.subject || '';
              const f       = msg.envelope.from?.[0];
              const from    = f ? (f.name ? `${f.name} <${f.address}>` : f.address) : '';
              texts.push(`${subject} ${from}`);
            }
          }
        } finally { lock.release(); }
        return texts;
      });
    } catch (_) { return []; } // 이 폴더가 없거나 계속 실패해도 학습 전체를 막지 않음
  }

  // 폴더 내 전체 메시지를 대상 폴더로 이동 — Nate 등 1000개 슬라이딩 윈도우 서버 대응
  // 패스마다 락을 재취득: UID SEARCH ALL로 현재 창의 UID를 얻고 이동, 빈 폴더가 될 때까지 반복
  // Nate처럼 MOVE(RFC 6851)가 없는 서버에서 ImapFlow의 messageMove는 COPY가 실패해도
  // (대상 폴더 없음 등) 에러 없이 원본을 지워버린다 — 메일이 어디로도 안 가고 사라진다.
  // 그래서 COPY 성공을 확인한 뒤에만 원본을 지운다.
  async _moveChunk(uids, targetFolder) {
    if (this.imap.capabilities.has('MOVE')) {
      const moved = await this.imap.messageMove(uids, targetFolder, { uid: true });
      if (!moved) throw new Error(`MOVE 실패 (대상: ${targetFolder})`);
      return;
    }
    const copied = await this.imap.messageCopy(uids, targetFolder, { uid: true });
    if (!copied) throw new Error(`COPY 실패 (대상: ${targetFolder}) — 원본은 지우지 않음`);
    await this.imap.messageDelete(uids, { uid: true });
  }

  // 대상 폴더가 없으면 미리 만든다 (이미 있는 폴더에 CREATE를 보내면 Nate가 연결을 끊으므로 목록 확인 후)
  async _ensureFolders(names) {
    const existing = new Set(await this.listFolders());
    for (const name of names) {
      if (existing.has(name)) continue;
      await this.createFolder(name);
      logger.info('SYSTEM', `[IMAP] 폴더 "${name}" 생성`);
    }
    this._folderListCache = null;
  }

  // 폴더에 \Deleted 표시만 되고 지워지지 않은 메일의 표시를 해제한다. Nate는 UIDPLUS가 없어
  // EXPUNGE가 폴더 전체의 \Deleted 메일을 지우므로, 이동 작업 전에 우리가 표시하지 않은
  // 메일이 휩쓸려 지워지지 않게 한다. 표시 해제는 메일을 지우지 않으므로 항상 안전하다.
  async clearDeletedFlags(folder) {
    const lock = await this.imap.getMailboxLock(folder);
    try {
      const flagged = await this.imap.search({ deleted: true }, { uid: true });
      for (let i = 0; i < flagged.length; i += 50) {
        await this.imap.messageFlagsRemove(flagged.slice(i, i + 50), ['\\Deleted'], { uid: true });
      }
      return flagged.length;
    } finally { lock.release(); }
  }

  async countMessages(folder) {
    const lock = await this.imap.getMailboxLock(folder);
    try {
      return (await this.imap.search({ all: true }, { uid: true })).length;
    } finally { lock.release(); }
  }

  async countDeletedFlagged(folder) {
    const lock = await this.imap.getMailboxLock(folder);
    try {
      return (await this.imap.search({ deleted: true }, { uid: true })).length;
    } finally { lock.release(); }
  }

  // EXPUNGE를 일으키는 작업(이동·삭제) 전에 호출 — 이 앱이 표시하지 않은 \\Deleted 메일이 휩쓸려
  // 지워지지 않게 표시를 해제하고(메일은 보존됨), 해제한 게 있으면 새 연결로 다시 확인한다.
  // 해제가 안 되면 아무것도 하지 않고 중단한다.
  async _prepareFolderForExpunge(folder) {
    const cleared = await this.clearDeletedFlags(folder);
    if (!cleared) return;
    logger.warn('SYSTEM', `[IMAP] "${folder}" 삭제 표시만 된 메일 ${cleared}통 표시 해제 (메일은 보존)`);
    await this.reconnect();
    const left = await this.countDeletedFlagged(folder);
    if (left) throw new Error(`"${folder}"에 삭제 표시된 메일 ${left}통이 해제되지 않아 안전을 위해 중단합니다 (아무 메일도 옮기거나 지우지 않았습니다)`);
  }

  // uids 중 folder에 아직 남아 있는 것 (50개씩 나눠 조회)
  async findExistingUids(folder, uids) {
    const found = [];
    for (let i = 0; i < uids.length; i += 50) {
      const chunk = uids.slice(i, i + 50);
      const hit = await this._withReconnectRetry(async () => {
        const lock = await this.imap.getMailboxLock(folder);
        try { return await this.imap.search({ uid: chunk.join(',') }, { uid: true }); }
        finally { lock.release(); }
      });
      found.push(...hit);
    }
    return found;
  }

  // 폴더의 UID 전체 (폴더가 없으면 빈 배열)
  async _searchAllUids(folder) {
    let lock;
    try { lock = await this.imap.getMailboxLock(folder); }
    catch (err) { if (!this.usable) throw err; return []; }
    try { return await this.imap.search({ all: true }, { uid: true }); }
    finally { try { lock.release(); } catch (_) {} }
  }

  // sourceFolder의 메일을 모두 targetFolder로 옮긴다.
  // Nate는 같은 연결 안에서는 이미 옮긴 메일을 SEARCH에 계속 돌려준다(갱신 지연). 예전에는 그걸
  // 매번 다시 옮기고 다시 세서 같은 작업을 수백 번 반복했다(로그의 "108,000개 이동").
  // 그래서 이번 실행에서 옮긴 UID는 다시 옮기지 않고, 옮길 게 없어지면 새 연결로 다시 확인한다
  // (새 연결의 결과는 정확함). 새로 보이는 메일(1000통 표시 창이 밀려 드러난 메일 등)이 있으면
  // 이어서 옮기고, 없으면 끝낸다. 반환값은 새 연결 기준으로 원본에서 실제로 사라진 메일 수.
  async searchAndMoveAll(sourceFolder, targetFolder, chunkSize = 50, onProgress) {
    await this._ensureFolders([targetFolder]);
    if ((await this.listFolders()).includes(sourceFolder)) await this._prepareFolderForExpunge(sourceFolder);
    const attempted = new Set();
    let remaining = [];
    let failStreak = 0;

    for (let round = 0; round < 50; round++) {
      for (let pass = 0; pass < 100; pass++) {
        if (!this.usable) { try { await this.reconnect(); } catch (_) { break; } }

        let lock;
        try { lock = await this.imap.getMailboxLock(sourceFolder); }
        catch (_) {
          if (this.usable || ++failStreak > 5) break; // 폴더 없음 등, 또는 연결 실패 반복
          try { await this.reconnect(); } catch (_2) { break; }
          continue;
        }

        let todo = [];
        let connLost = false;
        let stop = false;
        try {
          const uids = await this.imap.search({ all: true }, { uid: true });
          todo = uids.filter((u) => !attempted.has(u));
          for (let i = 0; i < todo.length; i += chunkSize) {
            if (!this.usable) { connLost = true; break; }
            const chunk = todo.slice(i, i + chunkSize);
            try {
              await this._moveChunk(chunk, targetFolder);
            } catch (moveErr) {
              if (!this.usable) { connLost = true; break; }
              logger.warn('SYSTEM', `[IMAP] "${sourceFolder}" → "${targetFolder}" 이동 실패: ${moveErr.message}`);
              stop = true;
              break;
            }
            chunk.forEach((u) => attempted.add(u));
            if (onProgress) onProgress(attempted.size);
          }
        } catch (_) {
          if (this.usable) stop = true; else connLost = true;
        } finally {
          try { lock.release(); } catch (_) {}
        }

        if (connLost) {
          if (++failStreak > 5) break;
          try { await this.reconnect(); } catch (_) { break; }
          continue;
        }
        failStreak = 0;
        if (stop || !todo.length) break;
      }

      // 새 연결로 실제로 남은 메일 확인
      try {
        await this.reconnect();
        remaining = await this._withReconnectRetry(() => this._searchAllUids(sourceFolder));
      } catch (err) {
        logger.warn('SYSTEM', `[IMAP] "${sourceFolder}" 남은 메일 확인 실패: ${err.message}`);
        break;
      }
      if (!remaining.some((u) => !attempted.has(u))) break; // 새로 보이는 메일 없음 → 완료
    }

    const left = new Set(remaining);
    return [...attempted].filter((u) => !left.has(u)).length;
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
    const buckets   = {};
    const subjects  = {};
    const unmatched = [];
    let total       = 0;
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
          subjects[msg.uid] = msg.envelope.subject || '(제목 없음)';
        } else {
          unmatched.push(msg.uid);
        }
        if (onProgress) onProgress(total);
      }
    } catch (err) {
      fetchError = err;
      // 연결 끊김이어도 지금까지 수집한 buckets는 유효
    } finally {
      try { lock.release(); } catch (_) {}
    }
    return { buckets, subjects, unmatched, total, error: fetchError };
  }

  // TEMP 폴더에서 카테고리별로 분류된 UID를 각 카테고리 폴더로 MOVE
  // 미분류 메일은 TEMP에 그대로 남김 (나중에 searchAndMoveAll로 INBOX 복원)
  async moveCategorizedFromFolder(folder, buckets) {
    const CHUNK  = 50;
    const result = { catMoved: {}, movedUids: {} };

    const entries = Object.entries(buckets).filter(([, uids]) => uids.length > 0);
    if (!entries.length) return result;

    if (!this.usable) await this.reconnect();
    await this._ensureFolders(entries.map(([targetFolder]) => targetFolder));
    const lock = await this.imap.getMailboxLock(folder);
    try {
      for (const [targetFolder, uids] of entries) {
        for (let i = 0; i < uids.length; i += CHUNK) {
          const chunk = uids.slice(i, i + CHUNK);
          try {
            await this._moveChunk(chunk, targetFolder);
          } catch (err) {
            err.partial = result; // 실패 전까지 옮긴 것은 호출 쪽이 기록할 수 있게
            throw err;
          }
          result.catMoved[targetFolder] = (result.catMoved[targetFolder] || 0) + chunk.length;
          (result.movedUids[targetFolder] ||= []).push(...chunk);
        }
      }
    } finally {
      lock.release();
    }
    return result;
  }

  // 지정한 UID들을 targetFolder로 옮긴다 (COPY 확인 후 원본 삭제). 실패하면 err.partial에 옮긴 UID 목록.
  async moveUids(folder, uids, targetFolder) {
    const CHUNK = 50;
    const moved = [];
    if (!uids.length) return moved;
    if (!this.usable) await this.reconnect();
    await this._ensureFolders([targetFolder]);
    const lock = await this.imap.getMailboxLock(folder);
    try {
      for (let i = 0; i < uids.length; i += CHUNK) {
        const chunk = uids.slice(i, i + CHUNK);
        try {
          await this._moveChunk(chunk, targetFolder);
        } catch (err) {
          err.partial = moved;
          throw err;
        }
        moved.push(...chunk);
      }
    } finally { lock.release(); }
    return moved;
  }




  // 지정한 UID만 정확히 지운다. Nate는 UIDPLUS가 없어 EXPUNGE가 "이 폴더에서 \\Deleted로
  // 표시된 모든 메일"을 지우므로, 우리가 표시하기 전에 이미 \\Deleted인 메일이 있으면
  // 무관한 메일까지 같이 지워질 수 있다 — 그래서 실행 전 항상 사전 점검한다.
  // Nate는 명령에 OK를 응답하고도 (특히 새 연결의 처음 몇 개 폴더에서) 실제로는 반영하지
  // 않는 경우가 있어("OneDrive 정리" 때 이미 겪음), 삭제 후 대상 UID가 실제로 사라졌는지
  // SEARCH로 다시 확인한다. 남아있으면 재연결 후 다시 시도한다.
  // UID를 전부 한 명령에 넣으면(수백 개) Nate가 자르거나 무시하는 것으로 보여, 다른
  // 기능들과 동일하게 50개씩 나눠서 처리·검증한다.
  async deleteExactUids(folder, uids) {
    const CHUNK = 50;
    const total = uids.length;
    if (!total) return 0;
    let deleted = 0;

    for (let i = 0; i < uids.length; i += CHUNK) {
      let target = uids.slice(i, i + CHUNK);
      let done = false;
      for (let attempt = 1; attempt <= 3 && !done; attempt++) {
        const lock = await this.imap.getMailboxLock(folder);
        let remaining;
        try {
          const preExisting = await this.imap.search({ deleted: true }, { uid: true });
          if (preExisting.length) {
            throw new Error(`"${folder}"에 이미 삭제 표시(\\Deleted)된 메일이 ${preExisting.length}개 있어 안전하게 처리할 수 없음 — 건너뜀`);
          }
          await this.imap.messageDelete(target, { uid: true });
          remaining = await this.imap.search({ uid: target.join(',') }, { uid: true });
        } finally { lock.release(); }

        if (!remaining.length) { done = true; deleted += target.length; }
        else {
          logger.warn('SYSTEM', `[IMAP] "${folder}" 청크 삭제 후 검증 실패 — ${remaining.length}/${target.length}개 여전히 존재 (${attempt}회) — 재연결 후 재시도`);
          await this.reconnect();
          target = remaining;
        }
      }
      if (!done) throw new Error(`"${folder}"에서 일부 메일이 3회 시도 후에도 삭제되지 않음 (누적 삭제 ${deleted}/${total})`);
    }
    return deleted;
  }

  // 영구 삭제 — 50통씩 나눠 지우고 실제로 사라졌는지 확인한다(deleteExactUids).
  // Nate의 EXPUNGE는 폴더 전체의 \\Deleted 메일을 지우므로, 먼저 남의 삭제 표시를 해제한다.
  async deleteMessages(encodedIds) {
    let count = 0;
    for (const [folder, uids] of Object.entries(groupByFolder(encodedIds))) {
      await this._prepareFolderForExpunge(folder);
      count += await this.deleteExactUids(folder, uids);
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
    // SUBSCRIBE — Nate는 명시적 구독 없이 SELECT를 거부하는 경우가 있음
    try { await this.imap.mailboxSubscribe(name); } catch (_) {}
  }

  async deleteFolder(path) {
    try { await this.imap.mailboxDelete(path); }
    catch (err) {
      const msg = `${err.message || ''} ${err.responseText || ''}`.toLowerCase();
      if (!msg.includes('nonexistent') && !msg.includes('does not exist') && !msg.includes('no such')) throw err;
    }
  }

  async _moveTo(encodedIds, targetFolder) {
    const resolvedTarget = await this.resolveFolder(targetFolder);
    const CHUNK = 50;
    let count = 0;
    for (const [folder, uids] of Object.entries(groupByFolder(encodedIds))) {
      if (folder === resolvedTarget) { count += uids.length; continue; }
      await this._prepareFolderForExpunge(folder);
      // 폴더당 단일 잠금 — 청크마다 재취득 시 Nate가 BYE를 보내는 문제 방지
      const lock = await this.imap.getMailboxLock(folder);
      try {
        for (let i = 0; i < uids.length; i += CHUNK) {
          const chunk = uids.slice(i, i + CHUNK);
          await this._moveChunk(chunk, resolvedTarget);
          count += chunk.length;
        }
      } finally { lock.release(); }
    }
    return count;
  }
}

module.exports = { ImapClient };
