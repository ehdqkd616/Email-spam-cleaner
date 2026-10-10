// 테스트용 가짜 IMAP 서버 + 공용 도구.
// 실제 Nate/Naver에서 확인한 동작을 옵션으로 흉내 낸다 (실제 메일함·로그·분류 기록에는 접근하지 않음).
//
//   기본(Nate)        MOVE·UIDPLUS 없음 → ImapFlow처럼 COPY+삭제표시+EXPUNGE로 이동을 흉내 냄.
//                     없는 폴더로 COPY하면 에러 없이 false, EXPUNGE는 폴더 전체의 \Deleted 메일을 지움
//   stale             같은 연결 안에서는 SEARCH/FETCH가 옛 목록(이미 옮긴 메일 포함)을 돌려줌
//   window            폴더당 앞쪽(UID 작은 순) N통만 보임 (Nate의 1000통 표시 한계)
//   deferredExpunge   EXPUNGE는 아무것도 안 지우고, 삭제표시된 메일은 재연결 때 사라짐
//   skipDeleteOnce    첫 삭제 요청을 서버가 OK만 하고 무시함
//   dropAfterCopyOnCall: [n]  n번째 삭제 요청에서 삭제표시 후 EXPUNGE 전에 연결이 끊김
//   noUnflag          삭제표시 해제 요청을 무시함
//   failCreate        폴더 생성 실패
//   failCopyFrom      해당 폴더에서의 COPY가 항상 실패
//   naver             MOVE·UIDPLUS·SPECIAL-USE 지원 (정식 MOVE, 지정 UID만 EXPUNGE)
//   specialUse        { 폴더경로: '\\Sent' ... }
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 실제 로그/분류 기록 파일에 쓰지 않도록 프로젝트 모듈을 불러오기 전에 스텁
function installStubs() {
  const noop = () => {};
  require.cache[path.join(ROOT, 'src/logger.js')] = { id: 'logger', filename: 'logger', loaded: true, exports: { info: noop, warn: noop, error: noop, success: noop, debug: noop } };
  require.cache[path.join(ROOT, 'src/history.js')] = { id: 'history', filename: 'history', loaded: true, exports: { addRecord: noop, getHistory: () => [] } };
}

function makeFakeImap(initial, opts = {}) {
  const {
    window = Infinity, stale = false, deferredExpunge = false, skipDeleteOnce = false,
    dropAfterCopyOnCall = [], noUnflag = false, failCreate = false, failCopyFrom = null,
    naver = false, specialUse = {},
  } = opts;

  let nextUid = 1000;
  const boxes = new Map();
  for (const [p, msgs] of Object.entries(initial)) {
    const m = new Map();
    for (const env of msgs) { const uid = nextUid++; m.set(uid, { uid, envelope: env, flags: new Set(env._flags || []) }); }
    boxes.set(p, m);
  }

  let current = null;
  let deleteCalls = 0;
  let skipped = false;
  let connId = 0;
  const snapshots = new Map();
  const stats = { copyCalls: 0, copiedMsgs: 0, nativeMoves: 0 };

  const box = () => { if (!current || !boxes.has(current)) throw new Error('no mailbox'); return boxes.get(current); };
  const toList = (r) => (Array.isArray(r) ? r : String(r).split(',').map(Number));
  const liveList = (p) => [...boxes.get(p).values()].sort((a, b) => a.uid - b.uid).slice(0, window);
  const view = (p) => {
    if (!stale) return liveList(p);
    const k = `${connId}:${p}`;
    if (!snapshots.has(k)) snapshots.set(k, liveList(p));
    return snapshots.get(k);
  };
  const dead = () => { if (!imap.usable) throw new Error('Connection not available'); };

  const imap = {
    usable: true,
    capabilities: new Map(naver
      ? [['IMAP4rev1', true], ['MOVE', true], ['UIDPLUS', true], ['SPECIAL-USE', true]]
      : [['IMAP4rev1', true]]),
    get mailbox() { return { exists: current && boxes.has(current) ? boxes.get(current).size : 0 }; },
    async getMailboxLock(p) {
      dead();
      if (!boxes.has(p)) { const e = new Error('Command failed'); e.responseStatus = 'NO'; throw e; }
      current = p;
      return { path: p, release() {} };
    },
    async list() { dead(); return [...boxes.keys()].map((p) => ({ path: p, flags: new Set(), specialUse: specialUse[p] || null })); },
    async status(p) { dead(); if (!boxes.has(p)) throw new Error('no mailbox'); return { path: p, messages: boxes.get(p).size }; },
    async mailboxCreate(p) { dead(); if (failCreate) throw new Error('CREATE failed'); if (boxes.has(p)) throw new Error('mailbox exists'); boxes.set(p, new Map()); },
    async mailboxSubscribe() {},
    async mailboxRename() { throw new Error('not used'); },
    async mailboxDelete(p) { dead(); boxes.delete(p); },
    async search(q) {
      dead();
      box();
      let items = q.deleted ? liveList(current) : view(current);
      if (q.deleted) items = items.filter((m) => m.flags.has('\\Deleted'));
      if (q.uid) { const s = new Set(toList(q.uid)); items = items.filter((m) => s.has(m.uid)); }
      if (q.or) {
        const hit = (m, c) => (c.subject && (m.envelope.subject || '').toLowerCase().includes(c.subject.toLowerCase()))
          || (c.from && JSON.stringify(m.envelope.from || []).toLowerCase().includes(c.from.toLowerCase()));
        items = items.filter((m) => q.or.some((c) => hit(m, c)));
      }
      return items.map((m) => m.uid);
    },
    async *fetch(range) {
      dead();
      box();
      let items = view(current);
      if (typeof range === 'string' && /^\d+:\*$/.test(range)) { const lo = Number(range.split(':')[0]); items = items.filter((m) => m.uid >= lo); }
      if (Array.isArray(range)) { const want = new Set(range); items = items.filter((m) => want.has(m.uid)); }
      for (const m of items) {
        yield { uid: m.uid, envelope: m.envelope, flags: m.flags, internalDate: m.envelope._internal || m.envelope.date, headers: m.envelope._headers ? Buffer.from(m.envelope._headers) : undefined };
      }
    },
    async messageCopy(uids, dest) {
      dead();
      if (!boxes.has(dest)) return false; // ImapFlow copy.js: TRYCREATE → 에러 없이 false
      if (failCopyFrom && current === failCopyFrom) return false;
      const src = box();
      stats.copyCalls++;
      for (const u of toList(uids)) {
        const m = src.get(u); if (!m) continue; // 이미 사라진 UID는 조용히 무시 (실제 서버와 같음)
        stats.copiedMsgs++;
        const nu = nextUid++;
        boxes.get(dest).set(nu, { uid: nu, envelope: m.envelope, flags: new Set() });
      }
      return { uidMap: new Map() };
    },
    async messageFlagsAdd(uids, flags) { dead(); const b = box(); for (const u of toList(uids)) b.get(u)?.flags.add(flags[0]); },
    async messageFlagsRemove(uids, flags) { dead(); if (noUnflag) return; const b = box(); for (const u of toList(uids)) b.get(u)?.flags.delete(flags[0]); },
    async messageDelete(uids) { // ImapFlow expunge.js: \Deleted 표시 후 EXPUNGE
      dead();
      deleteCalls++;
      if (skipDeleteOnce && !skipped) { skipped = true; return true; }
      await imap.messageFlagsAdd(uids, ['\\Deleted']);
      if (dropAfterCopyOnCall.includes(deleteCalls)) { imap.usable = false; throw new Error('Connection not available'); }
      if (deferredExpunge) return true;
      const b = box();
      if (naver) { for (const u of toList(uids)) b.delete(u); return true; } // UID EXPUNGE: 지정한 것만
      for (const [u, m] of [...b]) if (m.flags.has('\\Deleted')) b.delete(u); // 일반 EXPUNGE: 폴더 전체
      return true;
    },
    async messageMove(uids, dest) {
      if (naver) { // 정식 MOVE: 대상이 없으면 아무것도 안 하고 false
        dead();
        if (!boxes.has(dest)) return false;
        stats.nativeMoves++;
        const src = box();
        for (const u of toList(uids)) {
          const m = src.get(u); if (!m) continue;
          src.delete(u);
          const nu = nextUid++;
          boxes.get(dest).set(nu, { uid: nu, envelope: m.envelope, flags: new Set() });
        }
        return { uidMap: new Map() };
      }
      // ImapFlow move.js의 MOVE 미지원 폴백 그대로: COPY 결과와 무관하게 원본 삭제
      const r = await imap.messageCopy(uids, dest);
      await imap.messageDelete(uids);
      return r;
    },
    async logout() {}, close() {},
  };

  return {
    imap, boxes, stats,
    reconnect() {
      if (deferredExpunge) for (const b of boxes.values()) for (const [u, m] of [...b]) if (m.flags.has('\\Deleted')) b.delete(u);
      connId++;
      imap.usable = true;
    },
    count: (p) => (boxes.has(p) ? boxes.get(p).size : null),
  };
}

// 실제 ImapClient에 가짜 서버를 붙인 클라이언트 클래스
function makeClientClass(getFake) {
  const { ImapClient } = require(path.join(ROOT, 'src/imap/client.js'));
  return class FakeClient extends ImapClient {
    constructor(creds) { super(creds || { user: 'u', password: 'p' }, { host: 'fake', port: 1, folders: { INBOX: 'INBOX', TRASH: '휴지통', SPAM: '스팸' } }); this.imap = getFake().imap; }
    async connect() {}
    async reconnect() { getFake().reconnect(); }
    async disconnect() {}
  };
}

const env = (subject, address = 'someone@gmail.com', messageId = '', extra = {}) => ({
  subject,
  from: [{ name: address.split('@')[0], address }],
  date: new Date('2026-09-01T00:00:00Z'),
  messageId,
  ...extra,
});

function allMessages(boxes) {
  const out = [];
  for (const [p, m] of boxes) for (const msg of m.values()) out.push({ folder: p, subject: msg.envelope.subject, deleted: msg.flags.has('\\Deleted') });
  return out;
}

function makeChecker() {
  const results = [];
  return {
    async test(name, fn) {
      try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
    },
    report() {
      for (const r of results) console.log(r.join(' | '));
      const failed = results.filter((r) => r[0] === 'FAIL').length;
      console.log(`\n${results.length - failed}/${results.length} passed`);
      return failed;
    },
  };
}

module.exports = { ROOT, installStubs, makeFakeImap, makeClientClass, env, allMessages, makeChecker };
