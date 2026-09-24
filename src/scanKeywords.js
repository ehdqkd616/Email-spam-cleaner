/**
 * 광고성 키워드 / noreply 발신자 패턴 — Gmail·Naver·Nate 스캔 기준 통일
 *
 * 기존에는 서비스마다 이 목록이 조금씩 달라 "같은 메일인데 어떤 서비스는
 * 걸리고 어떤 서비스는 안 걸리는" 문제가 있었음. 세 서비스 전부 이 파일을
 * 참조하므로, 여기만 고치면 모든 서비스에 동일하게 반영됨.
 */

// 제목에 포함되면 광고 확률이 높은 키워드 (한글)
const AD_KEYWORDS = [
  '광고', '할인', '이벤트', '쿠폰', '무료', '무료배송', '특가',
  '혜택', '프로모션', '캐시백', '리워드', '적립', '사은품',
];

// 제목에 포함되면 광고 확률이 높은 키워드 (영문 — 구문 단위라 따옴표로 감싸야 함)
const AD_KEYWORDS_EN = ['limited offer'];

// noreply·자동발송 발신자 패턴
const NOREPLY_SENDERS = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'notification', 'notifications', 'alert', 'alerts',
  'mailer', 'mailbot', 'newsletter',
];

module.exports = { AD_KEYWORDS, AD_KEYWORDS_EN, NOREPLY_SENDERS };
