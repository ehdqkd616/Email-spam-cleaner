// 읽기 전용 헤더 확인 API(/api/mail/:provider/headers)를 가짜 Nate 서버로 검증한다.
// 실제 메일함·로그·분류 기록에는 접근하지 않는다.  실행: node test/headers.test.js
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');

const noop = () => {};
require.cache[path.join(ROOT, 'src/logger.js')] = { id: 'logger', filename: 'logger', loaded: true, exports: { info: noop, warn: noop, error: noop, success: noop, debug: noop } };
require.cache[path.join(ROOT, 'src/history.js')] = { id: 'history', filename: 'history', loaded: true, exports: { addRecord: noop, getHistory: () => [] } };

const { ImapClient } = require(path.join(ROOT, 'src/imap/client.js'));

function makeFakeNate(initial) {
  let nextUid = 1000;
  const boxes = new Map();
  for (const [p, msgs] of Object.entries(initial)) {
    boxes.set(p, new Map(msgs.map((env) => { const uid = nextUid++; return [uid, { uid, envelope: env, flags: new Set() }]; })));
  }
  let current = null;
  const box = () => boxes.get(current);
  const writes = [];
  const imap = {
    usable: true,
    capabilities: new Map([['IMAP4rev1', true]]),
    async getMailboxLock(p, opts = {}) {
      if (!boxes.has(p)) { const e = new Error('Command failed'); e.responseStatus = 'NO'; throw e; }
      current = p; if (!opts.readOnly) writes.push(`SELECT ${p}`);
      return { release() {} };
    },
    async list() { return [...boxes.keys()].map((p) => ({ path: p, flags: new Set() })); },
    async search(q) {
      let items = [...box().values()];
      if (q.or) {
        const hit = (m, c) => (c.subject && (m.envelope.subject || '').toLowerCase().includes(c.subject.toLowerCase()))
          || (c.from && JSON.stringify(m.envelope.from || []).toLowerCase().includes(c.from.toLowerCase()));
        items = items.filter((m) => q.or.some((c) => hit(m, c)));
      }
      return items.map((m) => m.uid);
    },
    async *fetch(range) {
      const want = new Set(Array.isArray(range) ? range : []);
      for (const m of box().values()) {
        if (want.size && !want.has(m.uid)) continue;
        yield { uid: m.uid, envelope: m.envelope, internalDate: m.envelope._internal, headers: m.envelope._headers ? Buffer.from(m.envelope._headers) : undefined };
      }
    },
    async messageCopy() { writes.push('COPY'); return false; },
    async messageMove() { writes.push('MOVE'); return false; },
    async messageDelete() { writes.push('DELETE'); return false; },
    async messageFlagsAdd() { writes.push('STORE'); },
    async messageFlagsRemove() { writes.push('STORE'); },
    async mailboxCreate() { writes.push('CREATE'); },
    async mailboxDelete() { writes.push('DELETE MAILBOX'); },
    async logout() {}, close() {},
  };
  return { imap, boxes, writes };
}

let SHARED;
class FakeNateClient extends ImapClient {
  constructor(creds) { super(creds, { host: 'fake', port: 1, folders: { INBOX: 'INBOX', TRASH: '휴지통', SPAM: '스팸' } }); this.imap = SHARED.imap; }
  async connect() {}
  async reconnect() {}
  async disconnect() {}
}
require.cache[path.join(ROOT, 'src/nate/client.js')] = { id: 'nate', filename: 'nate', loaded: true, exports: { NateClient: FakeNateClient } };
const router = require(path.join(ROOT, 'src/api/routes/mail.js'));

function get(url) {
  return new Promise((resolve, reject) => {
    let body = '';
    const query = Object.fromEntries(new URL(url, 'http://x').searchParams); // Express가 채워주는 req.query와 동일하게
    const req = { method: 'GET', url, originalUrl: url, headers: {}, query, session: { providers: { nate: { user: 'u', password: 'p' } } } };
    const res = {
      statusCode: 200, setHeader() {}, flushHeaders() {}, write(c) { body += c; }, end() { resolve({ status: this.statusCode, body }); },
      status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, body: JSON.stringify(o) }); },
    };
    router.handle(req, res, (err) => reject(err || new Error('route not matched')));
  });
}

const env = (subject, address, extra = {}) => ({ subject, from: [{ name: address.split('@')[0], address }], date: new Date('2026-09-01T00:00:00Z'), messageId: `<${subject}>`, ...extra });

(async () => {
  const dataDir = path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const before = new Set(fs.readdirSync(dataDir));

  const owm = env('OpenWeatherMap API 사용 방법', 'robot3@openweathermap.org', {
    date: new Date('2007-04-21T03:56:00Z'),
    _internal: new Date('2026-04-21T03:56:10Z'),
    _headers: 'Date: Sat, 21 Apr 2007 12:56:00 +0900\r\nReceived: from mx.openweathermap.org by mx.nate.com; Tue, 21 Apr 2026 12:56:10 +0900',
  });
  SHARED = makeFakeNate({ INBOX: [env('개인', 'b@gmail.com')], '개인·기타': [owm, env('다른 메일', 'c@gmail.com')], '빈 폴더': [] });

  const ok = await get('/nate/headers?q=OpenWeatherMap');
  const bad = await get('/nate/headers?q=' + encodeURIComponent('날씨'));
  const created = fs.readdirSync(dataDir).filter((f) => !before.has(f));
  created.forEach((f) => fs.unlinkSync(path.join(dataDir, f)));

  const r = JSON.parse(ok.body);
  const results = [];
  const check = (name, fn) => { try { fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); } };
  check('검색어에 맞는 메일 1통만 반환', () => assert.strictEqual(r.count, 1, ok.body.slice(0, 300)));
  check('폴더·보낸 쪽 날짜·서버 받은 시각·Received 헤더 포함', () => {
    const m = r.messages[0];
    assert.strictEqual(m.folder, '개인·기타');
    assert.ok(m.headerDate.startsWith('2007-04-21'), m.headerDate);
    assert.ok(m.internalDate.startsWith('2026-04-21'), m.internalDate);
    assert.ok(m.rawHeaders.includes('Received:'));
  });
  check('메일을 바꾸는 명령은 하나도 보내지 않음 (읽기 전용)', () => assert.deepStrictEqual(SHARED.writes, []));
  check('메일 수 변동 없음', () => { assert.strictEqual(SHARED.boxes.get('개인·기타').size, 2); assert.strictEqual(SHARED.boxes.get('INBOX').size, 1); });
  check('결과 파일 1개 저장', () => assert.strictEqual(created.length, 1));
  check('한글 검색어는 400과 안내 메시지', () => { assert.strictEqual(bad.status, 400); assert.ok(JSON.parse(bad.body).error.includes('영문')); });

  for (const x of results) console.log(x.join(' | '));
  const failed = results.filter((x) => x[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
