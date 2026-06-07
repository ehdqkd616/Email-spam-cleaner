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
    this._folders = { ...DEFAULT_FOLDERS, ...folders };
    this._email   = user;
    this.imap = new ImapFlow({
      host, port, secure: true,
      auth: { user, pass: password },
      logger: false,
      tls: { rejectUnauthorized: false },
      // 연결 유지를 위한 소켓 타임아웃 (ms)
      socketTimeout: 60000,
    });
    // 'error' 이벤트 미청취 시 Node 프로세스 전체 크래시 방지
    // (ImapFlow가 연결 끊김 시 error 이벤트를 emit — 리스너 없으면 uncaughtException)
    this.imap.on('error', () => {});
  }

  get folders() { return this._folders; }

  async connect()    { await this.imap.connect(); }
  async disconnect() { try { await this.imap.logout(); } catch (_) {} }
  async getProfile() { return { emailAddress: this._email }; }

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

  // SEARCH 없이 폴더 전체 메시지 메타데이터 조회 (서버 결과 수 제한 우회)
  // 한 번에 최대 MAX_FETCH개씩 배치 처리 — 서버 타임아웃·메모리 과부하 방지
  async fetchAllMetadata(folder) {
    const MAX_FETCH = 2000; // 한 번에 가져올 최대 메시지 수
    const results = [];

    // 먼저 폴더 내 전체 UID 목록 조회
    const lock0 = await this.imap.getMailboxLock(folder, { readOnly: true });
    let allUids;
    try {
      allUids = await this.imap.search({ all: true }, { uid: true });
    } finally { lock0.release(); }

    if (!allUids || !allUids.length) return results;

    // UID를 MAX_FETCH 단위로 청크 분할하여 순차 fetch
    for (let i = 0; i < allUids.length; i += MAX_FETCH) {
      const chunk = allUids.slice(i, i + MAX_FETCH);
      const lock  = await this.imap.getMailboxLock(folder, { readOnly: true });
      try {
        for await (const msg of this.imap.fetch(chunk, { envelope: true, uid: true }, { uid: true })) {
          const f = msg.envelope?.from?.[0];
          const fromStr = f ? (f.name ? `${f.name} <${f.address}>` : f.address) : '';
          results.push({
            id: encodeId(folder, msg.uid), uid: msg.uid, folder,
            payload: { headers: [
              { name: 'Subject', value: msg.envelope?.subject || '' },
              { name: 'From',    value: fromStr },
              { name: 'Date',    value: safeIso(msg.envelope?.date) || '' },
            ]},
          });
        }
      } finally { lock.release(); }
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
      if (!msg.includes('already exists') && !msg.includes('alreadyexists')) throw err;
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
    let count = 0;
    for (const [folder, uids] of Object.entries(groupByFolder(encodedIds))) {
      if (folder === targetFolder) { count += uids.length; continue; }
      const lock = await this.imap.getMailboxLock(folder);
      try { await this.imap.messageMove(uids, targetFolder, { uid: true }); count += uids.length; }
      finally { lock.release(); }
    }
    return count;
  }
}

module.exports = { ImapClient };
