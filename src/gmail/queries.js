// Gmail 전용 검색 쿼리 + 자동 필터 정의
// {R} 자리에 읽음 상태 필터(is:unread / is:read / 없음)가 주입됩니다.

const QUERIES = {
  promotions: {
    name: '프로모션 탭',
    description: '프로모션 탭 메일',
    baseQuery: 'category:promotions {R}older_than:30d',
    safe: true,
  },
  social: {
    name: '소셜 탭',
    description: '소셜 탭 메일',
    baseQuery: 'category:social {R}older_than:30d',
    safe: true,
  },
  adKeywords: {
    name: '광고성 키워드',
    description: '광고·할인·이벤트 등 키워드 포함 메일',
    baseQuery: [
      'subject:(광고 OR 할인 OR 이벤트 OR 쿠폰 OR 무료 OR 특가 OR "limited offer")',
      '{R}older_than:30d',
      '-subject:(결제 OR 입금 OR 영수증 OR 인증 OR 비밀번호 OR invoice OR verify)',
    ].join(' '),
    safe: false,
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
  noreply: {
    name: '자동 발송 알림',
    description: 'noreply·알림 주소에서 온 메일',
    baseQuery: [
      'from:(noreply OR no-reply OR notification OR alert OR mailer)',
      '{R}older_than:30d',
      '-from:(noreply@google.com OR noreply@accounts.google.com)',
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

module.exports = { QUERIES, buildQuery, FILTER_DEFINITIONS };
