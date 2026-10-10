// ImapClient 이동·삭제·중복 정리 로직 검증 (가짜 Nate 서버).  실행: node test/client.test.js
const path = require('path');
const fs = require('fs');
const Module = require('module');
const assert = require('assert');
const { ROOT, installStubs, makeFakeImap, makeClientClass, env, makeChecker } = require('./fake-imap');

installStubs();

let FAKE;
const FakeClient = makeClientClass(() => FAKE);
function setup(initial, opts) { FAKE = makeFakeImap(initial, opts); return { f: FAKE, c: new FakeClient() }; }

// mail.js 내부 헬퍼를 파일 수정 없이 꺼내 쓰기
function loadMailHelpers() {
  const file = path.join(ROOT, 'src/api/routes/mail.js');
  const src = fs.readFileSync(file, 'utf8') + '\nmodule.exports.__t = { scanAllFoldersForDuplicates, dedupeGroups, scanAndDedupe };';
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(src, file);
  return m.exports.__t;
}

const silent = () => {};
const subjects = (f, p) => [...f.boxes.get(p).values()].map((m) => m.envelope.subject);

(async () => {
  const T = makeChecker();

  await T.test('[버그 재현] MOVE 미지원 서버에서 messageMove는 없는 폴더로 옮길 때 원본을 지운다', async () => {
    const { f } = setup({ INBOX: [env('a'), env('b')] });
    await f.imap.getMailboxLock('INBOX');
    await f.imap.messageMove([1000, 1001], '의료·건강');
    assert.strictEqual(f.count('INBOX'), 0);
    assert.strictEqual(f.count('의료·건강'), null);
  });

  await T.test('_moveChunk: 없는 폴더로 옮기면 예외, 원본 보존', async () => {
    const { f, c } = setup({ INBOX: [env('a'), env('b')] });
    await f.imap.getMailboxLock('INBOX');
    await assert.rejects(() => c._moveChunk([1000, 1001], '의료·건강'), /COPY 실패/);
    assert.strictEqual(f.count('INBOX'), 2);
  });

  await T.test('moveCategorizedFromFolder: 없는 카테고리 폴더를 먼저 만들고 옮긴다', async () => {
    const { f, c } = setup({ INBOX: [], SortTemp: [env('병원 예약'), env('세미나'), env('영수증')], '결제·영수증': [] });
    const r = await c.moveCategorizedFromFolder('SortTemp', { '의료·건강': [1000], '이벤트·행사': [1001], '결제·영수증': [1002] });
    assert.strictEqual(f.count('SortTemp'), 0);
    assert.strictEqual(f.count('의료·건강'), 1);
    assert.strictEqual(f.count('이벤트·행사'), 1);
    assert.strictEqual(f.count('결제·영수증'), 1);
    assert.deepStrictEqual(r.catMoved, { '의료·건강': 1, '이벤트·행사': 1, '결제·영수증': 1 });
  });

  await T.test('searchAndMoveAll: 120통 전부 이동, 원본 비고 대상에 정확히 120통', async () => {
    const { f, c } = setup({ INBOX: Array.from({ length: 120 }, (_, i) => env(`m${i}`)), SortTemp: [] });
    assert.strictEqual(await c.searchAndMoveAll('INBOX', 'SortTemp', 50), 120);
    assert.strictEqual(f.count('INBOX'), 0);
    assert.strictEqual(f.count('SortTemp'), 120);
  });

  await T.test('searchAndMoveAll: 대상 폴더가 없으면 먼저 만들어서 옮긴다', async () => {
    const { f, c } = setup({ INBOX: [env('a')] });
    assert.strictEqual(await c.searchAndMoveAll('INBOX', 'SortTemp', 50), 1);
    assert.strictEqual(f.count('SortTemp'), 1);
    assert.strictEqual(f.count('INBOX'), 0);
  });

  await T.test('searchAndMoveAll(옛 목록 + 표시 창 50통): 이동 수가 실제와 같고 같은 메일 반복 이동 없음', async () => {
    const { f, c } = setup({ INBOX: Array.from({ length: 120 }, (_, i) => env(`m${i}`)), SortTemp: [] }, { stale: true, window: 50 });
    assert.strictEqual(await c.searchAndMoveAll('INBOX', 'SortTemp', 50), 120);
    assert.strictEqual(f.count('INBOX'), 0);
    assert.strictEqual(f.count('SortTemp'), 120);
    assert.strictEqual(f.stats.copyCalls, 3); // 50 + 50 + 20
  });

  await T.test('[위험 재현] 삭제표시만 된 메일이 있으면 이동 중 EXPUNGE에 같이 지워진다', async () => {
    const { f, c } = setup({ INBOX: [env('keep-me'), env('move-me')], SortTemp: [] });
    await f.imap.getMailboxLock('INBOX');
    await f.imap.messageFlagsAdd([1000], ['\\Deleted']);
    await f.imap.getMailboxLock('INBOX');
    await c._moveChunk([1001], 'SortTemp');
    assert.strictEqual(f.count('INBOX'), 0);
  });

  await T.test('clearDeletedFlags 후에는 삭제표시만 된 메일이 이동에 휩쓸리지 않는다', async () => {
    const { f, c } = setup({ INBOX: [env('keep-me'), env('move-me')], SortTemp: [] });
    await f.imap.getMailboxLock('INBOX');
    await f.imap.messageFlagsAdd([1000], ['\\Deleted']);
    assert.strictEqual(await c.clearDeletedFlags('INBOX'), 1);
    assert.strictEqual(await c.countDeletedFlagged('INBOX'), 0);
    await f.imap.getMailboxLock('INBOX');
    await c._moveChunk([1001], 'SortTemp');
    assert.strictEqual(f.count('INBOX'), 1);
    assert.strictEqual(f.count('SortTemp'), 1);
  });

  await T.test('_moveTo(스팸/휴지통): 대상 폴더가 없으면 원본을 지우지 않고 예외', async () => {
    const { f, c } = setup({ INBOX: [env('a')] });
    await assert.rejects(() => c._moveTo(['INBOX||1000'], '없는폴더'), /COPY 실패/);
    assert.strictEqual(f.count('INBOX'), 1);
  });

  await T.test('countMessages: 비었는지 정확히 셈', async () => {
    const { c } = setup({ SortTemp: [env('a')], Empty: [] });
    assert.strictEqual(await c.countMessages('SortTemp'), 1);
    assert.strictEqual(await c.countMessages('Empty'), 0);
  });

  await T.test('영구 삭제(deleteMessages): 대상만 지우고 남의 삭제표시 메일은 보존', async () => {
    const { f, c } = setup({ INBOX: [env('광고1'), env('광고2'), env('예전에 표시만 된 메일')] });
    await f.imap.getMailboxLock('INBOX');
    await f.imap.messageFlagsAdd([1002], ['\\Deleted']);
    assert.strictEqual(await c.deleteMessages(['INBOX||1000', 'INBOX||1001']), 2);
    assert.deepStrictEqual(subjects(f, 'INBOX'), ['예전에 표시만 된 메일']);
  });

  await T.test('영구 삭제: 120통도 50통씩 나눠 정확히 삭제', async () => {
    const { f, c } = setup({ INBOX: Array.from({ length: 121 }, (_, i) => env(`m${i}`)) });
    const ids = Array.from({ length: 120 }, (_, i) => `INBOX||${1000 + i}`);
    assert.strictEqual(await c.deleteMessages(ids), 120);
    assert.strictEqual(f.count('INBOX'), 1);
  });

  await T.test('휴지통 이동(trashMessages): 남의 삭제표시 메일이 휩쓸려 지워지지 않음', async () => {
    const { f, c } = setup({ INBOX: [env('광고'), env('예전에 표시만 된 메일')], 'Deleted Messages': [] });
    await f.imap.getMailboxLock('INBOX');
    await f.imap.messageFlagsAdd([1001], ['\\Deleted']);
    assert.strictEqual(await c.trashMessages(['INBOX||1000']), 1);
    assert.strictEqual(f.count('Deleted Messages'), 1);
    assert.deepStrictEqual(subjects(f, 'INBOX'), ['예전에 표시만 된 메일']);
  });

  const { cleanupOldFolders } = require(path.join(ROOT, 'src/imap/categorizer.js'));
  const quiet = async (fn) => { const o = console.log; console.log = () => {}; try { await fn(); } finally { console.log = o; } };

  await T.test('[위험 재현] 표시 창(50통)을 넘는 폴더는 searchInFolder로 보이는 것만 돌려받는다', async () => {
    const { c } = setup({ INBOX: [], '[옛폴더]': Array.from({ length: 120 }, (_, i) => env(`o${i}`)) }, { window: 50 });
    assert.strictEqual((await c.searchInFolder('[옛폴더]', {}, 9999)).length, 50);
  });

  await T.test('옛 폴더 정리: 표시 한계를 넘어 120통 전부 받은편지함으로, 빈 걸 확인한 뒤 폴더 삭제', async () => {
    const { f, c } = setup({ INBOX: [], '[옛폴더]': Array.from({ length: 120 }, (_, i) => env(`o${i}`)) }, { window: 50 });
    await quiet(() => cleanupOldFolders(c));
    assert.strictEqual(f.count('INBOX'), 120);
    assert.strictEqual(f.count('[옛폴더]'), null);
  });

  await T.test('옛 폴더 정리: 이동이 실패하면 폴더를 지우지 않고 메일 보존', async () => {
    const { f, c } = setup({ INBOX: [], '[옛폴더]': [env('a'), env('b')] }, { failCopyFrom: '[옛폴더]' });
    await quiet(() => cleanupOldFolders(c));
    assert.strictEqual(f.count('[옛폴더]'), 2);
    assert.strictEqual(f.count('INBOX'), 0);
  });

  const H = loadMailHelpers();

  await T.test('중복 정리: 그룹당 1통만 남고 INBOX 사본이 남는다', async () => {
    const e1 = env('약관 개정', 'kbank@x.com', '<id-1>');
    const { f, c } = setup({ INBOX: [e1, e1, e1], SortTemp: [e1, e1], '금융·은행': [env('다른 메일', 'b@x.com', '<id-2>')] });
    assert.strictEqual((await H.scanAndDedupe(c, silent)).deleted, 4);
    assert.strictEqual(f.count('INBOX'), 1);
    assert.strictEqual(f.count('SortTemp'), 0);
    assert.strictEqual(f.count('금융·은행'), 1);
  });

  await T.test('중복 정리: Message-ID 없는 메일도 제목+발신자+날짜로 묶어 정리', async () => {
    const e = env('포인트 소멸 안내', 'daiso@x.com', '');
    const { f, c } = setup({ SortTemp: [e, e, e, e] });
    assert.strictEqual((await H.scanAndDedupe(c, silent)).deleted, 3);
    assert.strictEqual(f.count('SortTemp'), 1);
  });

  await T.test('중복 정리: 보낸편지함/내게쓴메일함/휴지통/임시보관함 사본은 건드리지 않는다', async () => {
    const self = env('나에게 보낸 메모', 'me@x.com', '<self-1>');
    const { f, c } = setup({ INBOX: [self], 'Sent Messages': [self], '내게쓴메일함': [self], 'Deleted Messages': [self], Drafts: [self] });
    assert.strictEqual((await H.scanAndDedupe(c, silent)).deleted, 0);
    for (const p of ['INBOX', 'Sent Messages', '내게쓴메일함', 'Deleted Messages', 'Drafts']) assert.strictEqual(f.count(p), 1, p);
  });

  await T.test('중복 정리: 초 단위 시각이 다른 비슷한 메일은 남긴다', async () => {
    const a = { ...env('이용권 등록 완료', 'kakao@x.com', ''), date: new Date('2026-09-11T16:08:51Z') };
    const b = { ...env('이용권 등록 완료', 'kakao@x.com', ''), date: new Date('2026-09-11T16:08:56Z') };
    const { f, c } = setup({ INBOX: [a, b] });
    assert.strictEqual((await H.scanAndDedupe(c, silent)).deleted, 0);
    assert.strictEqual(f.count('INBOX'), 2);
  });

  await T.test('중복 정리: 폴더에 남의 삭제표시가 있으면 그 폴더는 건너뛴다', async () => {
    const e1 = env('dup', 's@x.com', '<d1>');
    const { f, c } = setup({ INBOX: [e1, e1, env('other', 's@x.com', '<o1>')] });
    await f.imap.getMailboxLock('INBOX');
    await f.imap.messageFlagsAdd([1002], ['\\Deleted']);
    await H.scanAndDedupe(c, silent);
    assert.strictEqual(f.count('INBOX'), 3);
  });

  await T.test('중복 정리 범위 지정: 작업하지 않은 폴더의 기존 중복은 건드리지 않음', async () => {
    const d = env('네이버 쇼핑 특가', 'shop@naver.com', '<promo>');
    const e1 = env('dup', 's@x.com', '<d1>');
    const { f, c } = setup({ INBOX: [e1, e1], '프로모션': [d, d] });
    await H.scanAndDedupe(c, silent, ['INBOX']);
    assert.strictEqual(f.count('INBOX'), 1);
    assert.strictEqual(f.count('프로모션'), 2);
  });

  await T.test('디버그 로거: 형식이 이상한 로그에도 서버가 죽지 않고 로그인·인증 줄은 숨김', async () => {
    const prev = process.env.IMAP_DEBUG;
    process.env.IMAP_DEBUG = '1';
    const { NateClient } = require(path.join(ROOT, 'src/nate/client.js')); // 실제 클라이언트 (연결은 하지 않음)
    const c = new NateClient({ user: 'x', password: 'y' });
    const L = c.imap.options.logger;
    const out = [];
    const w = process.stderr.write;
    process.stderr.write = (s) => { out.push(String(s)); return true; };
    try {
      L.debug({}); L.debug(undefined); L.debug('plain'); L.warn({ err: new Error('boom') }); L.error({});
      L.debug({ src: 'c', msg: '1 LOGIN user pass' });
      L.debug({ src: 'c', msg: 'AGVoZHFrZDYxNjEAKCogdmFsdWUgaGlkZGVuICop' });
      L.debug({ src: 'c', msg: '5 SELECT INBOX' });
    } finally { process.stderr.write = w; process.env.IMAP_DEBUG = prev; }
    const text = out.join('');
    assert.ok(text.includes('[IMAP-WARN] boom'));
    assert.ok(text.includes('5 SELECT INBOX'));
    assert.ok(!text.includes('LOGIN') && !text.includes('AGVoZHFr'));
  });

  process.exit(T.report() ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });

