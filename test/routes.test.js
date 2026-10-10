// "분류 실행"·"전체 재분류 실행"·폴더 확인 라우트를 가짜 Nate/Naver 서버로 처음부터 끝까지 검증한다.
// 실행: node test/routes.test.js
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { ROOT, installStubs, makeFakeImap, makeClientClass, env, allMessages, makeChecker } = require('./fake-imap');

installStubs();
let FAKE;
const FakeClient = makeClientClass(() => FAKE);
require.cache[path.join(ROOT, 'src/nate/client.js')] = { id: 'nate', filename: 'nate', loaded: true, exports: { NateClient: FakeClient } };
require.cache[path.join(ROOT, 'src/naver/client.js')] = { id: 'naver', filename: 'naver', loaded: true, exports: { NaverClient: FakeClient } };
const router = require(path.join(ROOT, 'src/api/routes/mail.js'));

function run(url) {
  return new Promise((resolve, reject) => {
    let body = '';
    const query = Object.fromEntries(new URL(url, 'http://x').searchParams);
    const req = { method: 'GET', url, originalUrl: url, headers: {}, query, session: { providers: { nate: { user: 'u', password: 'p' }, naver: { user: 'u', password: 'p' } } } };
    const res = {
      statusCode: 200, setHeader() {}, flushHeaders() {}, write(c) { body += c; }, end() { resolve(body); },
      status(c) { this.statusCode = c; return this; }, json(o) { resolve(JSON.stringify(o)); },
    };
    router.handle(req, res, (err) => reject(err || new Error('route not matched')));
  });
}
const lines = (ev) => [...ev.matchAll(/"message":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
const total = (ev) => { const m = ev.match(/event: complete\ndata: (\{.*?\})/); return m ? JSON.parse(m[1]).total : NaN; };
const sorted = (a) => [...a].sort();
const subjectsOf = (list) => sorted(list.map((e) => e.subject));

(async () => {
  const T = makeChecker();

  // ── Nate: 실제 사고 상황 — SortTemp 잔여, 삭제표시 메일, 없는 카테고리 폴더, 복사 후 연결 끊김 ──
  {
    const inbox = [
      env('[병원] 진료 예약 안내', 'noti@hospital.co.kr', '<h1>'),
      env('건강검진 결과 안내', 'noti@checkup.co.kr', '<h2>'),
      env('주문하신 상품이 배송 시작', 'shop@coupang.com', '<o1>'),
      env('결제 영수증', 'pay@toss.im', '<p1>'),
      env('이번 주말 저녁 약속', 'friend@naver.com', '<f1>'),
      { ...env('삭제 표시만 된 메일', 'someone@gmail.com', '<x1>'), _flags: ['\\Deleted'] },
      ...Array.from({ length: 60 }, (_, i) => env(`개인 메일 ${i}`, `p${i}@gmail.com`, `<n${i}>`)),
    ];
    const left = [env('예전에 남은 개인 메일', 'old@naver.com', '<l1>'), env('주문 상품 배송 시작 안내', 'shop@gmarket.co.kr', '<l2>')];
    FAKE = makeFakeImap({ INBOX: inbox, SortTemp: left, 'Sent Messages': [env('보낸 메일', 'me@nate.com', '<s1>')], '주문·배송': [], '결제·영수증': [] }, { dropAfterCopyOnCall: [1] });
    const ev = await run('/nate/categorize-all');
    const all = allMessages(FAKE.boxes).filter((m) => m.folder !== 'Sent Messages');
    await T.test('[Nate 사고 상황] 완료', () => assert.ok(ev.includes('event: complete'), ev.slice(-400)));
    await T.test('[Nate 사고 상황] 모든 메일 정확히 한 통씩 (유실 0·중복 0), 삭제표시 없음', () => {
      assert.deepStrictEqual(sorted(all.map((m) => m.subject)), subjectsOf([...inbox, ...left]));
      assert.ok(all.every((m) => !m.deleted));
    });
    await T.test('[Nate 사고 상황] SortTemp 삭제, 없던 의료·건강 생성(2통), 미분류는 INBOX', () => {
      assert.ok(!FAKE.boxes.has('SortTemp'));
      assert.strictEqual(FAKE.count('의료·건강'), 2);
      const inInbox = all.filter((m) => m.folder === 'INBOX').map((m) => m.subject);
      for (const s of ['이번 주말 저녁 약속', '삭제 표시만 된 메일', '예전에 남은 개인 메일', '개인 메일 59']) assert.ok(inInbox.includes(s), s);
    });
    await T.test('[Nate 사고 상황] 보낸편지함 그대로, 연결 끊김으로 생긴 중복을 안전망이 정리', () => {
      assert.strictEqual(FAKE.count('Sent Messages'), 1);
      assert.ok(/중복 \d+통 자동 정리 완료/.test(ev));
    });
  }

  // ── 사전 점검에서 막히면 아무것도 옮기지 않음 ──
  {
    FAKE = makeFakeImap({ INBOX: [env('[병원] 진료 예약 안내', 'noti@hospital.co.kr', '<h1>'), { ...env('표시된 메일', 'a@gmail.com', '<x>'), _flags: ['\\Deleted'] }, env('개인', 'b@gmail.com', '<b>')], SortTemp: [env('남은 메일', 'c@naver.com', '<c>')] }, { noUnflag: true });
    const ev = await run('/nate/categorize-all');
    await T.test('[사전 점검 중단] 에러로 멈추고 메일·폴더 그대로', () => {
      assert.ok(ev.includes('event: error') && ev.includes('아무 메일도 옮기지 않았습니다'));
      assert.strictEqual(FAKE.count('INBOX'), 3);
      assert.strictEqual(FAKE.count('SortTemp'), 1);
      assert.ok(!FAKE.boxes.has('의료·건강'));
    });
  }

  // ── 분류 이동이 계속 실패 → 유실 없이 복원, 무한 반복 없음 ──
  {
    const inbox = [env('[병원] 진료 예약 안내', 'noti@hospital.co.kr', '<h1>'), env('건강검진 결과 안내', 'noti@checkup.co.kr', '<h2>'), env('개인', 'b@gmail.com', '<b>')];
    FAKE = makeFakeImap({ INBOX: inbox, SortTemp: [] }, { failCreate: true });
    const ev = await run('/nate/categorize-all');
    await T.test('[이동 실패] 3통 모두 INBOX로 복원, SortTemp 삭제, 3회 연속 실패 후 멈춤', () => {
      assert.deepStrictEqual(sorted(allMessages(FAKE.boxes).map((m) => m.subject)), subjectsOf(inbox));
      assert.strictEqual(FAKE.count('INBOX'), 3);
      assert.ok(!FAKE.boxes.has('SortTemp'));
      assert.ok(ev.includes('3회 연속 실패'));
    });
  }

  // ── 분류 실행: 없는 카테고리 폴더, 삭제표시 메일 ──
  {
    const inbox = [env('[병원] 진료 예약 안내', 'noti@hospital.co.kr', '<h1>'), env('주문하신 상품이 배송 시작', 'shop@coupang.com', '<o1>'), env('개인', 'b@gmail.com', '<b>'), { ...env('표시된 메일', 'a@gmail.com', '<x>'), _flags: ['\\Deleted'] }];
    FAKE = makeFakeImap({ INBOX: inbox, '주문·배송': [] });
    const ev = await run('/nate/categorize');
    const all = allMessages(FAKE.boxes);
    await T.test('[분류 실행] 완료, 4통 모두 존재·삭제표시 없음, 의료·건강 생성', () => {
      assert.ok(ev.includes('event: complete'), ev.slice(-300));
      assert.deepStrictEqual(sorted(all.map((m) => m.subject)), subjectsOf(inbox));
      assert.ok(all.every((m) => !m.deleted));
      assert.strictEqual(FAKE.count('의료·건강'), 1);
      assert.deepStrictEqual(sorted(all.filter((m) => m.folder === 'INBOX').map((m) => m.subject)), ['개인', '표시된 메일']);
    });
  }

  // ── 옛 목록(stale): 숫자가 실제와 같고, 제목이 로그에 남고, 반복하지 않음 ──
  {
    const inbox = [env('[병원] 진료 예약 안내', 'noti@hospital.co.kr', '<h1>'), env('주문하신 상품이 배송 시작', 'shop@coupang.com', '<o1>'), env('결제 영수증', 'pay@toss.im', '<p1>'), ...Array.from({ length: 30 }, (_, i) => env(`개인 메일 ${i}`, `p${i}@gmail.com`, `<n${i}>`))];
    FAKE = makeFakeImap({ INBOX: inbox, SortTemp: [env('예전에 남은 개인 메일', 'old@naver.com', '<l1>')], '주문·배송': [], '결제·영수증': [] }, { stale: true });
    const ev = await run('/nate/categorize-all');
    const L = lines(ev);
    await T.test('[옛 목록] 분류 수 3, 복원 수 31 (부풀림 없음)', () => {
      assert.strictEqual(total(ev), 3);
      assert.ok(L.some((l) => l.includes('총 31개 받은편지함으로 복원 완료')), L.filter((l) => l.includes('복원')).join(' / '));
    });
    await T.test('[옛 목록] 유실 0·중복 0, SortTemp 삭제, 같은 분류 반복 없음, 제목 로그', () => {
      assert.deepStrictEqual(sorted(allMessages(FAKE.boxes).map((m) => m.subject)), subjectsOf([...inbox, { subject: '예전에 남은 개인 메일' }]));
      assert.ok(!FAKE.boxes.has('SortTemp'));
      assert.strictEqual(L.filter((l) => l.includes('✓ [의료·건강]')).length, 1);
      for (const t of ['[병원] 진료 예약 안내', '주문하신 상품이 배송 시작', '결제 영수증']) assert.ok(L.some((l) => l.includes(`· ${t}`)), t);
    });
  }

  // ── 표시 창(50통) 밖의 메일까지 분류 ──
  {
    const inbox = [env('[병원] 진료 예약 안내', 'noti@hospital.co.kr', '<h1>'), ...Array.from({ length: 129 }, (_, i) => env(`개인 ${i}`, `q${i}@gmail.com`, `<q${i}>`)), env('결제 영수증', 'pay@toss.im', '<p1>')];
    FAKE = makeFakeImap({ INBOX: inbox, SortTemp: [], '결제·영수증': [] }, { stale: true, window: 50 });
    const ev = await run('/nate/categorize-all');
    await T.test('[표시 창 밖] 131통 유실 0·중복 0, 처음엔 안 보이던 결제 영수증도 분류', () => {
      assert.ok(ev.includes('event: complete'), ev.slice(-300));
      assert.deepStrictEqual(sorted(allMessages(FAKE.boxes).map((m) => m.subject)), subjectsOf(inbox));
      assert.strictEqual(FAKE.count('결제·영수증'), 1);
    });
  }

  // ── 실제 사고 조합: 옛 목록 + 복사 후 연결 끊김 ──
  {
    const inbox = [env('[병원] 진료 예약 안내', 'noti@hospital.co.kr', '<h1>'), env('주문하신 상품이 배송 시작', 'shop@coupang.com', '<o1>'), ...Array.from({ length: 60 }, (_, i) => env(`개인 ${i}`, `r${i}@gmail.com`, `<r${i}>`))];
    FAKE = makeFakeImap({ INBOX: inbox, SortTemp: [env('남은 메일', 'old@naver.com', '<l1>')], '주문·배송': [] }, { stale: true, dropAfterCopyOnCall: [1] });
    const ev = await run('/nate/categorize-all');
    const all = allMessages(FAKE.boxes);
    await T.test('[옛 목록 + 연결 끊김] 63통 정확히 한 통씩, 삭제표시 없음, SortTemp 삭제', () => {
      assert.ok(ev.includes('event: complete'), ev.slice(-300));
      assert.deepStrictEqual(sorted(all.map((m) => m.subject)), subjectsOf([...inbox, { subject: '남은 메일' }]));
      assert.ok(all.every((m) => !m.deleted));
      assert.ok(!FAKE.boxes.has('SortTemp'));
    });
  }

  // ── Nate식 지연 삭제 (EXPUNGE는 "지울 메일 없음", 실제 삭제는 연결 종료 후) ──
  {
    const inbox = [env('[무신사] 이메일 인증', 'noreply@musinsa.com', '<mu1>'), env('결제 영수증', 'pay@toss.im', '<p1>'), env('개인', 'b@gmail.com', '<b>')];
    FAKE = makeFakeImap({ INBOX: inbox, '결제·영수증': [], '보안알림': [] }, { stale: true, deferredExpunge: true });
    const ev = await run('/nate/categorize');
    const all = allMessages(FAKE.boxes);
    await T.test('[지연 삭제·분류 실행] 원본 사라짐 확인, 3통 정확히 한 통씩', () => {
      assert.ok(ev.includes('event: complete') && ev.includes('모두 사라진 것 확인'), ev.slice(-400));
      assert.deepStrictEqual(sorted(all.map((m) => m.subject)), subjectsOf(inbox));
      assert.ok(all.every((m) => !m.deleted));
    });
  }
  {
    const inbox = [env('결제 영수증', 'pay@toss.im', '<p1>'), env('개인', 'b@gmail.com', '<b>')];
    FAKE = makeFakeImap({ INBOX: inbox, '결제·영수증': [] }, { skipDeleteOnce: true });
    const ev = await run('/nate/categorize');
    await T.test('[원본 삭제 누락·분류 실행] 남은 원본 감지 후 중복 정리, 2통 정확히 한 통씩', () => {
      assert.ok(ev.includes('원본이 받은편지함에 남아 있음'), ev.slice(-500));
      assert.deepStrictEqual(sorted(allMessages(FAKE.boxes).map((m) => m.subject)), subjectsOf(inbox));
    });
  }
  {
    const inbox = [env('[병원] 진료 예약 안내', 'noti@hospital.co.kr', '<h1>'), env('결제 영수증', 'pay@toss.im', '<p1>'), ...Array.from({ length: 70 }, (_, i) => env(`개인 ${i}`, `s${i}@gmail.com`, `<s${i}>`))];
    FAKE = makeFakeImap({ INBOX: inbox, SortTemp: [env('남은 메일', 'old@naver.com', '<l1>')], '결제·영수증': [] }, { stale: true, deferredExpunge: true });
    const ev = await run('/nate/categorize-all');
    const all = allMessages(FAKE.boxes);
    await T.test('[지연 삭제·전체 재분류] 분류 수 2, 73통 정확히 한 통씩, SortTemp 삭제', () => {
      assert.strictEqual(total(ev), 2, ev.slice(-300));
      assert.deepStrictEqual(sorted(all.map((m) => m.subject)), subjectsOf([...inbox, { subject: '남은 메일' }]));
      assert.ok(!FAKE.boxes.has('SortTemp'));
      assert.ok(all.every((m) => !m.deleted));
    });
  }

  // ── Naver (MOVE·UIDPLUS·SPECIAL-USE) ──
  const naverSpecial = { INBOX: '\\Inbox', 'Sent Messages': '\\Sent', Drafts: '\\Drafts', Junk: '\\Junk', 'Deleted Messages': '\\Trash' };
  {
    const memo = env('나에게 보낸 메모', 'me@naver.com', '<self-1>');
    const inbox = [
      env('[병원] 진료 예약 안내', 'noti@hospital.co.kr', '<h1>'),
      env('결제 영수증', 'pay@toss.im', '<p1>'),
      memo,
      { ...env('다른 앱에서 삭제 표시한 메일', 'x@gmail.com', '<x1>'), _flags: ['\\Deleted'] },
      ...Array.from({ length: 60 }, (_, i) => env(`개인 ${i}`, `n${i}@gmail.com`, `<nv${i}>`)),
    ];
    FAKE = makeFakeImap({ INBOX: inbox, 'Sent Messages': [memo], 'Deleted Messages': [env('버린 메일', 'y@gmail.com', '<t1>')], Drafts: [], '결제·영수증': [] }, { naver: true, specialUse: naverSpecial });
    const ev = await run('/naver/categorize-all');
    const all = allMessages(FAKE.boxes);
    await T.test('[네이버 전체 재분류] 분류 수 2, 정식 MOVE만 사용 (COPY 흉내 0회)', () => {
      assert.strictEqual(total(ev), 2, ev.slice(-400));
      assert.ok(FAKE.stats.nativeMoves > 0);
      assert.strictEqual(FAKE.stats.copyCalls, 0);
    });
    await T.test('[네이버 전체 재분류] 받은편지함 쪽 유실 0·중복 0, SortTemp 삭제, 의료·건강 생성', () => {
      const side = all.filter((m) => !['Sent Messages', 'Deleted Messages'].includes(m.folder)).map((m) => m.subject);
      assert.deepStrictEqual(sorted(side), subjectsOf(inbox));
      assert.ok(!FAKE.boxes.has('SortTemp'));
      assert.strictEqual(FAKE.count('의료·건강'), 1);
    });
    await T.test('[네이버 전체 재분류] 보낸편지함의 같은 메모·휴지통 그대로, 다른 앱의 삭제표시 메일 보존', () => {
      assert.strictEqual(FAKE.count('Sent Messages'), 1);
      assert.strictEqual(FAKE.count('Deleted Messages'), 1);
      const m = all.find((x) => x.subject === '다른 앱에서 삭제 표시한 메일');
      assert.ok(m && !m.deleted && m.folder === 'INBOX');
    });
  }
  {
    const inbox = [env('[병원] 진료 예약 안내', 'noti@hospital.co.kr', '<h1>'), env('개인', 'b@gmail.com', '<b>')];
    FAKE = makeFakeImap({ INBOX: inbox, 'Sent Messages': [] }, { naver: true, specialUse: naverSpecial });
    const ev = await run('/naver/categorize');
    await T.test('[네이버 분류 실행] 원본 사라짐 확인, 유실 0, 의료·건강 생성', () => {
      assert.ok(ev.includes('event: complete') && ev.includes('모두 사라진 것 확인'), ev.slice(-300));
      assert.deepStrictEqual(sorted(allMessages(FAKE.boxes).map((m) => m.subject)), subjectsOf(inbox));
      assert.strictEqual(FAKE.count('의료·건강'), 1);
    });
  }
  {
    const memo = env('나에게 보낸 메모', 'me@naver.com', '<self-2>');
    FAKE = makeFakeImap({ INBOX: [memo, env('개인', 'b@gmail.com', '<b>')], '보낸 편지(Sent)': [memo] }, { naver: true, specialUse: { '보낸 편지(Sent)': '\\Sent' } });
    const ev = await run('/naver/categorize-all');
    await T.test('[네이버] 이름 목록에 없는 \\Sent 폴더도 서버 표시만으로 중복 정리에서 제외', () => {
      assert.ok(ev.includes('event: complete'), ev.slice(-300));
      assert.strictEqual(FAKE.count('보낸 편지(Sent)'), 1);
      assert.strictEqual(FAKE.count('INBOX'), 2);
    });
  }
  {
    const promo = env('네이버 쇼핑 특가', 'shop@naver.com', '<promo-dup>');
    const sns = env('카페 새 글 알림', 'cafe@naver.com', '<sns-dup>');
    const inbox = [
      env('[병원] 진료 예약 안내', 'noti@hospital.co.kr', '<r-h1>'),
      env('결제 영수증', 'pay@toss.im', '<r-p1>'),
      env('주문하신 상품이 배송 시작', 'shop@coupang.com', '<r-o1>'),
      env('[케이뱅크] 예금거래기본약관 개정 안내', 'kbank@kbanknow.com', '<r-k1>'),
      ...Array.from({ length: 300 }, (_, i) => env(`개인 메일 ${i}`, `r${i}@gmail.com`, `<r${i}>`)),
    ];
    const cats = ['SNS·커뮤니티', '결제·영수증', '계정·서비스', '공공·기관', '교육·학습', '구독·멤버십', '보안알림', '예약·예매', '의료·건강', '이벤트·행사', '주문·배송'];
    const init = { INBOX: inbox, 'Sent Messages': [env('보낸 메일', 'me@naver.com', '<sent1>')], Drafts: [], Junk: [], 'Deleted Messages': [env('버린 메일', 'z@gmail.com', '<del1>')], SNS: [sns, sns], '프로모션': [promo, promo], '청구·결제': [], '카페': [], '내게쓴메일함': [] };
    for (const c of cats) init[c] = [env(`기존 ${c} 메일`, 'old@x.co.kr', `<old-${c}>`)];
    FAKE = makeFakeImap(init, { naver: true, specialUse: naverSpecial });
    const before = sorted(allMessages(FAKE.boxes).map((m) => m.subject));
    const ev = await run('/naver/categorize-all');
    await T.test('[네이버 실제 폴더 구성] 전체 메일 그대로 (유실 0)', () => {
      assert.ok(ev.includes('event: complete'), ev.slice(-300));
      assert.deepStrictEqual(sorted(allMessages(FAKE.boxes).map((m) => m.subject)), before);
    });
    await T.test('[네이버 실제 폴더 구성] 네이버 자체 폴더(SNS·프로모션)의 기존 중복은 건드리지 않음', () => {
      assert.strictEqual(FAKE.count('SNS'), 2);
      assert.strictEqual(FAKE.count('프로모션'), 2);
    });
    await T.test('[네이버 실제 폴더 구성] 분류된 메일이 각 카테고리로', () => {
      assert.strictEqual(FAKE.count('의료·건강'), 2);
      assert.strictEqual(FAKE.count('결제·영수증'), 2);
      assert.strictEqual(FAKE.count('주문·배송'), 2);
      assert.ok(!FAKE.boxes.has('SortTemp'));
    });
  }
  {
    const dataDir = path.join(ROOT, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const before = new Set(fs.readdirSync(dataDir));
    FAKE = makeFakeImap({ INBOX: [env('a', 'a@gmail.com', '<a>')], 'Sent Messages': [], 'Deleted Messages': [] }, { naver: true, specialUse: naverSpecial });
    const r = JSON.parse(await run('/naver/folders'));
    const created = fs.readdirSync(dataDir).filter((f) => !before.has(f));
    created.forEach((f) => fs.unlinkSync(path.join(dataDir, f)));
    await T.test('[폴더 확인] 폴더·특수 용도·메일 수 반환, 메일 변동 없음, 결과 파일 1개', () => {
      assert.strictEqual(r.totalMessages, 1);
      assert.strictEqual(r.folders.find((f) => f.path === 'Sent Messages').specialUse, '\\Sent');
      assert.strictEqual(FAKE.count('INBOX'), 1);
      assert.strictEqual(created.length, 1);
    });
  }

  process.exit(T.report() ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
