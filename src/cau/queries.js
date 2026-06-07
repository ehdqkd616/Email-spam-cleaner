// CAU 학교 이메일 전용 검색 기준 (Microsoft Graph API 버전)
// 학교 이메일은 보존 우선 — 광고 쿼리를 최소화하고 정크 메일함 정리에 집중

const AD_KEYWORDS = ['광고', '할인', '이벤트', '쿠폰', '무료', '특가', 'unsubscribe'];

const QUERIES = {
  junkFolder: {
    name: '정크 메일함',
    description: 'Outlook이 자동 분류한 정크 메일함 전체',
    folder: 'junkemail',
    baseCriteria: {},
    applyDateFilter: false,
    safe: true,
  },
  inboxAd: {
    name: '받은편지함 광고성',
    description: '받은편지함 내 광고성 키워드 포함 (60일 이상, 학사 관련 자동 제외)',
    folder: 'inbox',
    baseCriteria: { _keywords: AD_KEYWORDS },
    applyDateFilter: true,
    safe: false,
  },
};

function buildCriteria(key, readFilter) {
  const def = QUERIES[key];
  if (!def) throw new Error(`알 수 없는 쿼리 키: ${key}`);

  const readPart = readFilter === 'is:unread' ? { seen: false }
                 : readFilter === 'is:read'   ? { seen: true  } : {};

  const datePart = def.applyDateFilter ? (() => {
    const d = new Date();
    d.setDate(d.getDate() - 60);
    return { before: d };
  })() : {};

  return { ...def.baseCriteria, ...readPart, ...datePart };
}

module.exports = { QUERIES, buildCriteria };
