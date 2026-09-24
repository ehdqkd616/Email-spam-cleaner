// Gmail 전용 검색 쿼리 + 자동 필터 정의
// {R} 자리에 읽음 상태 필터(is:unread / is:read / 없음)가 주입됩니다.
//
// 광고 키워드 / noreply 발신자 목록, 카테고리 키(adFolder/spamFolder/inboxKeywords/
// inboxNoreply)는 Naver·Nate와 통일 — 서비스마다 기준이 달라 결과가 달라지는
// 문제를 막기 위함 (src/scanKeywords.js)

const { AD_KEYWORDS, AD_KEYWORDS_EN, NOREPLY_SENDERS } = require('../scanKeywords');

const AD_SUBJECT_TERMS = [...AD_KEYWORDS, ...AD_KEYWORDS_EN.map((kw) => `"${kw}"`)].join(' OR ');
const NOREPLY_FROM_TERMS = NOREPLY_SENDERS.join(' OR ');

const QUERIES = {
  adFolder: {
    name: '프로모션 탭',
    description: 'Gmail이 자동 분류한 프로모션 탭 전체',
    baseQuery: 'category:promotions {R}older_than:30d',
    safe: true,
  },
  spamFolder: {
    name: '스팸함',
    description: 'Gmail이 자동 분류한 스팸함 전체',
    baseQuery: 'in:spam {R}',
    safe: true,
  },
  inboxKeywords: {
    name: '받은편지함 광고성 키워드',
    description: '광고 판별 엔진으로 자동 감지 (키워드+할인율+마케팅 발신 도메인 등 종합 판단, 받은편지함 전체)',
    // matcher: 'detectAd'가 있으면 이 baseQuery 대신 scanInboxForAds()가 쓰임
    // (13개 고정 키워드 substring보다 matcher.js의 스코어링 엔진이 훨씬 정확 — 자동 분류가
    // 광고 제외용으로 이미 쓰고 있는 동일 엔진을 재사용)
    baseQuery: [
      `subject:(${AD_SUBJECT_TERMS})`,
      '{R}',
      '-subject:(결제 OR 입금 OR 영수증 OR 인증 OR 비밀번호 OR invoice OR verify)',
    ].join(' '),
    matcher: 'detectAd',
    safe: false,
  },
  inboxNoreply: {
    name: '받은편지함 자동 발송',
    description: 'noreply·알림 주소에서 온 메일 (받은편지함 전체, 기간 제한 없음)',
    baseQuery: [
      `from:(${NOREPLY_FROM_TERMS})`,
      '{R}',
      '-from:(noreply@google.com OR noreply@accounts.google.com)',
    ].join(' '),
    safe: false,
  },
  // ── Gmail 고유 기능 (Naver·Nate에는 대응 폴더/탭이 없어 통일 대상에서 제외) ──
  social: {
    name: '소셜 탭',
    description: '소셜 탭 메일',
    baseQuery: 'category:social {R}older_than:30d',
    safe: true,
  },
  newsletter: {
    name: '뉴스레터 (unsubscribe 포함)',
    description: '수신거부 링크 포함 메일',
    baseQuery: [
      'unsubscribe {R}older_than:30d',
      '-subject:(결제 OR 입금 OR 영수증 OR 인증 OR invoice OR verify)',
    ].join(' '),
    safe: false,
  },
};

function buildQuery(key, readFilter) {
  const slot = readFilter ? `${readFilter} ` : '';
  return QUERIES[key].baseQuery.replace('{R}', slot);
}

const FILTER_DEFINITIONS = [
  {
    name: '[광고] 포함 → 프로모션 분류 + 읽음',
    criteria: { subject: '[광고]' },
    action: { addLabelIds: ['CATEGORY_PROMOTIONS'], removeLabelIds: ['INBOX', 'UNREAD'] },
  },
  {
    name: 'noreply 발신 → 받은편지함 건너뜀 + 읽음',
    criteria: { from: 'noreply OR no-reply' },
    action: { removeLabelIds: ['INBOX', 'UNREAD'] },
  },
  {
    name: 'unsubscribe 제목 → 프로모션 분류',
    criteria: { subject: 'unsubscribe' },
    action: { addLabelIds: ['CATEGORY_PROMOTIONS'], removeLabelIds: ['INBOX'] },
  },
];

// buildCriteria: 다른 프로바이더(naver/nate)와 동일한 이름으로도 접근 가능하게 별칭 제공
// (웹 스캔 라우트가 프로바이더 구분 없이 QUERIES/buildCriteria를 사용하므로 필수)
module.exports = { QUERIES, buildQuery, buildCriteria: buildQuery, FILTER_DEFINITIONS };
