/**
 * Naver IMAP 검색 기준 정의
 *
 * IMAP SEARCH 결과는 서버에서 1차 필터링,
 * imap/cleaner.js의 PRESERVATION이 2차 보호 (trancaction 메일 제외)
 */

// 광고 확정 키워드 (제목에 포함 시 광고 확률 매우 높음)
const AD_STRONG_KW = [
  '할인', '쿠폰', '특가', '이벤트', '혜택', '프로모션',
  '캐시백', '리워드', '적립', '사은품', '무료배송',
];

// noreply 발신자 패턴
const NOREPLY_SENDERS = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'notification', 'notifications', 'alert', 'alerts',
  'mailer', 'mailbot', 'newsletter',
];

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
    description: '스팸 메일함 전체',
    folder: '스팸메일함',
    baseCriteria: {},
    applyDateFilter: false,
    safe: true,
  },
  inboxKeywords: {
    name: '받은편지함 광고성 키워드',
    description: '광고·할인·이벤트 키워드 포함 (30일 이상, 트랜잭션 제외)',
    folder: 'INBOX',
    baseCriteria: { or: AD_STRONG_KW.map((kw) => ({ subject: kw })) },
    applyDateFilter: true,
    safe: false,
  },
  inboxNoreply: {
    name: '받은편지함 자동 발송',
    description: 'noreply·알림 주소에서 온 메일 (30일 이상)',
    folder: 'INBOX',
    baseCriteria: { or: NOREPLY_SENDERS.map((kw) => ({ from: kw })) },
    applyDateFilter: true,
    safe: false,
  },
};

// NAVER_QUERIES는 기존 코드와의 호환을 위해 QUERIES도 내보냄
const QUERIES = NAVER_QUERIES;

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

module.exports = { QUERIES, NAVER_QUERIES, buildCriteria };
