// Nate Mail IMAP 검색 기준
// adFolder: 광고함 (Nate 고유 폴더명)
// spamFolder: 스팸 (Nate는 '스팸메일함' 아닌 '스팸')

const AD_KEYWORDS     = ['광고', '할인', '이벤트', '쿠폰', '무료', '특가'];
const NOREPLY_SENDERS = ['noreply', 'no-reply', 'notification', 'alert', 'mailer'];

const QUERIES = {
  adFolder: {
    name: '광고함',
    description: 'Nate가 자동 분류한 광고함 전체',
    folder: '광고함',
    baseCriteria: {},
    applyDateFilter: false,
    safe: true,
  },
  spamFolder: {
    name: '스팸 메일함',
    description: '스팸 메일함 전체',
    folder: '스팸',
    baseCriteria: {},
    applyDateFilter: false,
    safe: true,
  },
  inboxKeywords: {
    name: '받은편지함 광고성 키워드',
    description: '받은편지함 내 광고·할인·이벤트 키워드 (30일 이상)',
    folder: 'INBOX',
    baseCriteria: { or: AD_KEYWORDS.map((kw) => ({ subject: kw })) },
    applyDateFilter: true,
    safe: false,
  },
  inboxNoreply: {
    name: '받은편지함 자동 발송',
    description: '받은편지함 내 noreply·알림 주소 발신 (30일 이상)',
    folder: 'INBOX',
    baseCriteria: { or: NOREPLY_SENDERS.map((kw) => ({ from: kw })) },
    applyDateFilter: true,
    safe: false,
  },
};

function buildCriteria(key, readFilter) {
  const def = QUERIES[key];
  if (!def) throw new Error(`알 수 없는 쿼리 키: ${key}`);
  const readPart = readFilter === 'is:unread' ? { seen: false }
                 : readFilter === 'is:read'   ? { seen: true  } : {};
  const datePart = def.applyDateFilter ? (() => { const d = new Date(); d.setDate(d.getDate() - 30); return { before: d }; })() : {};
  return { ...def.baseCriteria, ...readPart, ...datePart };
}

module.exports = { QUERIES, buildCriteria };
