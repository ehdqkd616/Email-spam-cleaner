/**
 * 공통 보존 예외 기준 — Gmail·IMAP cleaner 모두 사용
 *
 * 광고 스캔 결과에서 삭제 전 최종 보호 대상 판별.
 * 단순 키워드 포함이 아닌, 구체적인 트랜잭션·보안 패턴으로 강화.
 *
 * matcher.js의 detectAd()와 역할 분담:
 *  - matcher.js: 자동 분류 시 광고 필터링
 *  - queries.js PRESERVATION: 광고 스캔 결과에서 실제 메일 보호
 */

const { CATEGORIES } = require('./categories');

// ── 트랜잭션 보호 키워드 (이 단어가 있으면 절대 삭제하지 않음) ──
// 광고에서 거의 사용하지 않는 구체적인 완료형 표현
const TRANSACTIONAL_KEYWORDS = [
  // 결제 완료
  '결제 완료', '결제 승인', '결제 확인', '결제 실패',
  '승인 번호', '승인번호',
  '영수증', '세금계산서', '청구서',
  '납부 완료', '입금 확인', '입금 완료',
  '환불 완료', '환불 처리',
  // 인증·보안
  '인증번호', '인증 번호', '인증코드', '인증 코드',
  'OTP', '임시 비밀번호', '보안 코드',
  '비밀번호 변경', '비밀번호 재설정',
  '새 기기', '새로운 기기', '로그인 알림', '로그인 시도',
  '계정 잠금', '계정 정지',
  // 주문·배송
  '주문 확인', '주문 완료', '주문 접수',
  '발송 완료', '출고 완료', '배송 완료', '배송 조회',
  '송장 번호', '운송장 번호', '택배 도착',
  // 학교·교육 관련
  '수강', '성적', '졸업', '장학', '등록금',
  // 영문
  'invoice', 'receipt', 'order confirmation',
  'payment confirmation', 'verification code', 'one-time password',
  'new sign-in', 'password reset', 'tracking number',
  'your order', 'shipment',
];

// 보존 도메인 (이 발신자 도메인에서 온 메일은 보존)
const PRESERVATION_DOMAINS = [
  // 구글
  '@accounts.google.com', '@account.google.com', '@google.com',
  // 네이버
  '@naver.com', '@navercorp.com', '@nidlogin.naver.com',
  // 마이크로소프트
  '@microsoft.com', '@account.microsoft.com', '@microsoftonline.com',
  // 카카오
  '@kakao.com', '@kakaocorp.com',
  // 애플
  '@apple.com', '@appleid.apple.com',
  // 교육
  '@ac.kr', '@edu',
  // 추가: 카테고리 발신 도메인
  ...new Set(CATEGORIES.flatMap((c) => c.senderDomains).map((d) => `@${d}`)),
];

const PRESERVATION = {
  subjectKeywords: TRANSACTIONAL_KEYWORDS,
  senderDomains:   PRESERVATION_DOMAINS,
};

module.exports = { PRESERVATION };
