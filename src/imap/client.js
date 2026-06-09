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
  // mailbox.exists로 전체 수 파악 후 BATCH 단위 시퀀스 범위 fetch
  // — Nate 등 서버별 FETCH 응답 수 제한(1000개 등) 우회
  async fetchAllMetadata(folder, onProgress) {
    const BATCH   = 500;
    const results = [];

    // 폴더 선택 → 전체 메시지 수 확인 후 즉시 해제
    const lock0 = await this.imap.getMailboxLock(folder, { readOnly: true });
    const total  = this.imap.mailbox?.exists ?? 0;
    lock0.release();

    if (total === 0) return results;

    for (let start = 1; start <= total; start += BATCH) {
      const end  = Math.min(start + BATCH - 1, total);
      const lock = await this.imap.getMailboxLock(folder, { readOnly: true });
      try {
        for await (const msg of this.imap.fetch(`${start}:${end}`, { envelope: true, uid: true })) {
          if (!msg.envelope || !msg.uid) continue; // UID 미반환 → NaN 인코딩 방지
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
      } finally { lock.release(); }
      if (onProgress) onProgress(end, total);
    }

    return results;
  }

  async trashMessages(ids)  { return this._moveTo(ids, this._folders.TRASH); }
  async markAsSpam(ids)     { return this._moveTo(ids, this._folders.SPAM);  }
  async moveTo(ids, folder) { return this._moveTo(ids, folder); }

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
    const CHUNK = 50; // 구형 IMAP 서버의 명령줄 길이 제한 우회
    let count = 0;
    for (const [folder, uids] of Object.entries(groupByFolder(encodedIds))) {
      if (folder === targetFolder) { count += uids.length; continue; }
      for (let i = 0; i < uids.length; i += CHUNK) {
        const chunk = uids.slice(i, i + CHUNK);
        const lock  = await this.imap.getMailboxLock(folder);
        try { await this.imap.messageMove(chunk, targetFolder, { uid: true }); count += chunk.length; }
        finally { lock.release(); }
      }
    }
    return count;
  }
}

module.exports = { ImapClient };
