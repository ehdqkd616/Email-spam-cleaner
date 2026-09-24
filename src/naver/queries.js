/**
 * Naver IMAP 검색 기준 정의
 *
 * IMAP SEARCH 결과는 서버에서 1차 필터링,
 * imap/cleaner.js의 PRESERVATION이 2차 보호 (trancaction 메일 제외)
 *
 * 광고 키워드 / noreply 발신자 목록은 Gmail·Nate와 공유 (src/scanKeywords.js)
 * — 서비스마다 기준이 달라 결과가 달라지는 문제를 막기 위함
 */

const { AD_KEYWORDS, NOREPLY_SENDERS } = require('../scanKeywords');

// ── 쿼리 정의 ────────────────────────────────────────────────────
const NAVER_QUERIES = {
  adFolder: {
    name: '광고 메일함',
    description: '네이버가 자동 분류한 광고 메일함 전체',
    folder: '광고메일함',
    baseCriteria: {},
    applyDateFilter: false,
    safe: true,
  },
  spamFolder: {
    name: '스팸 메일함',
    description: '네이버가 자동 분류한 스팸 메일함 전체',
    folder: '스팸메일함',
    baseCriteria: {},
    applyDateFilter: false,
    safe: true,
  },
  inboxKeywords: {
    name: '받은편지함 광고성 키워드',
    description: '광고 판별 엔진으로 자동 감지 (키워드+할인율+마케팅 발신 도메인 등 종합 판단, 받은편지함 전체)',
    folder: 'INBOX',
    // matcher: 'detectAd'가 있으면 scanInboxForAds()가 대신 쓰이므로 baseCriteria는 미사용 폴백
    baseCriteria: { or: AD_KEYWORDS.map((kw) => ({ subject: kw })) },
    applyDateFilter: false,
    matcher: 'detectAd',
    safe: false,
  },
  inboxNoreply: {
    name: '받은편지함 자동 발송',
    description: 'noreply·알림 주소에서 온 메일 (받은편지함 전체, 기간 제한 없음)',
    folder: 'INBOX',
    baseCriteria: { or: NOREPLY_SENDERS.map((kw) => ({ from: kw })) },
    applyDateFilter: false,
    safe: false,
  },
};

// NAVER_QUERIES는 기존 코드와의 호환을 위해 QUERIES도 내보냄
const QUERIES = NAVER_QUERIES;

// 나이브 베이즈 학습용 정답 데이터 폴더 — 계정에 이미 분류돼 있는 폴더를 그대로 활용
// (광고: 네이버가 자체 분류한 광고 메일함 / 정상: 이 앱의 자동분류가 만든 카테고리 폴더들, src/categories.js 참고)
// 계정에 해당 폴더가 없으면 fetchTrainingTexts()가 조용히 스킵하므로 안전함
const BAYES_TRAIN = {
  adFolders: ['광고메일함'],
  hamFolders: [
    '결제·영수증', '주문·배송', '예약·예매', '구독·멤버십',
    '계정·서비스', '금융·은행', 'SNS·커뮤니티', '이벤트·행사',
    '교육·학습', '공공·기관', '보안알림',
  ],
};

function buildCriteria(key, readFilter) {
  const def = NAVER_QUERIES[key];
  if (!def) throw new Error(`알 수 없는 쿼리 키: ${key}`);

  const readPart = readFilter === 'is:unread' ? { seen: false }
                 : readFilter === 'is:read'   ? { seen: true  } : {};
  const datePart = def.applyDateFilter
    ? (() => { const d = new Date(); d.setDate(d.getDate() - 30); return { before: d }; })()
    : {};

  return { ...def.baseCriteria, ...readPart, ...datePart };
}

module.exports = { QUERIES, NAVER_QUERIES, buildCriteria, BAYES_TRAIN };
