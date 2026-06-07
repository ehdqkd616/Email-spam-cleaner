/**
 * 자동 분류 카테고리 정의
 *
 * 처리 흐름: matcher.js의 detectAd()가 먼저 광고를 제외하고,
 * 이후 아래 카테고리 순서대로 매칭 (앞 카테고리가 우선순위 높음)
 *
 * 각 카테고리는 세 가지 방식으로 매칭:
 *  - subjectKeywords : 제목에 포함된 단어 (단어 단위, toLowerCase 비교)
 *  - subjectPhrases  : 정규식 패턴 (맥락이 있는 구문 매칭, 더 정밀)
 *  - senderDomains   : 발신자 주소 포함 도메인
 *
 * 우선순위 순서:
 *  1. 보안알림   — 계정 침해·인증은 최우선
 *  2. 공공·기관  — 건강보험·국세·정부는 결제보다 먼저 분류
 *  3. 의료·건강  — '진료 예약'이 일반 예약보다 먼저 걸려야 함
 *  4. 결제·영수증
 *  5. 주문·배송
 *  6. 예약·예매
 *  7. 구독·멤버십
 *  8. 계정·서비스
 *  9. 금융·은행
 * 10. SNS·커뮤니티
 * 11. 이벤트·행사
 * 12. 교육·학습
 */
const CATEGORIES = [
  // ── 1. 보안 알림 (최우선) ─────────────────────────────────────────
  {
    key: 'security',
    name: '보안알림',
    description: '로그인 알림, 비밀번호 변경, 인증번호, 보안 관련',
    subjectKeywords: [
      '인증번호', '인증코드', '인증 코드', '인증 메일', '이메일 인증',
      '본인인증', '본인 확인', '전화번호 인증', '휴대폰 인증',
      '비밀번호 변경', '비밀번호 재설정', '임시 비밀번호', '비밀번호 초기화',
      '새 기기', '새로운 기기', '새로운 환경', '새 환경', '새 브라우저',
      '로그인 알림', '로그인 시도', '로그인 감지', '로그인 확인',
      '접속 알림', '접속 시도', '접속 감지',
      '보안 코드', '보안 알림', '보안 경고', '보안 확인',
      '계정 잠금', '계정 정지', '계정 보호', '계정 이상',
      '2단계 인증', '이중 인증', '2차 인증',
      '비정상 접근', '비정상 로그인',
      'verification code', 'OTP', 'one-time password', 'one time password',
      'new device', 'new sign-in', 'sign-in alert', 'login alert',
      'password reset', 'password changed', 'account locked',
      'two-factor', '2fa', 'security alert', 'unusual activity',
      'verify your email', 'confirm your email', 'email verification',
    ],
    subjectPhrases: [
      /인증\s*(번호|코드)\s*[：:\s]\s*\d{4,}/,
      /OTP\s*[：:\s]\s*\d{4,}/,
      /새\s*(기기|환경|브라우저|위치)\s*(에서|로)\s*(로그인|접속)/,
      /로그인\s*(시도|알림|하셨|감지)/,
      /비밀번호\s*(변경|재설정|초기화)\s*(완료|요청|안내)/,
      /계정\s*(잠금|정지|비활성|이상|보호)/,
      /(새|최근)\s*(접속|로그인)\s*(알림|감지|시도)/,
      /본인\s*(인증|확인)\s*(완료|요청|안내)/,
      /2단계\s*인증\s*(설정|알림|요청)/,
      /비정상\s*(접근|로그인|활동)\s*(감지|알림)/,
      /(이메일|전화번호)\s*(인증|확인)\s*(요청|완료)/,
    ],
    senderDomains: [
      'accounts.google.com', 'account.google.com', 'no-reply.accounts.google.com',
      'navercorp.com', 'nidlogin.naver.com',
      'account.microsoft.com', 'microsoftonline.com', 'accountprotection.microsoft.com',
      'appleid.apple.com',
      'id.kakao.com', 'accounts.kakao.com',
    ],
  },

  // ── 2. 공공·기관 ──────────────────────────────────────────────────
  {
    key: 'government',
    name: '공공·기관',
    description: '국세청, 건강보험, 국민연금, 정부24 등 공공기관 고지·안내',
    subjectKeywords: [
      '국세청', '홈택스', '세금 안내', '세금 납부', '납세',
      '건강보험', '국민건강보험', '건강보험료',
      '국민연금', '고용보험', '산재보험',
      '정부24', '민원24', '주민센터',
      '재산세', '자동차세', '지방세', '종합소득세', '부가가치세',
      '과태료', '범칙금', '고지서', '납부고지서',
      '전자 고지', '전자고지서', '모바일 고지',
      '사회보험', '4대보험',
    ],
    subjectPhrases: [
      /(세금|납세|고지)\s*(안내|납부|고지서)/,
      /(건강보험|국민연금|고용보험|산재보험)\s*(안내|납부|확인|고지|청구)/,
      /(재산세|자동차세|지방세|소득세|부가가치세)\s*(납부|고지|안내)/,
      /전자\s*(고지서|납부)\s*(안내|확인|발송)/,
      /(과태료|범칙금)\s*(부과|납부|안내)/,
      /[가-힣]+(청|시|군|구|도)\s*(고지서|안내|납부)/,
    ],
    senderDomains: [
      'nts.go.kr', 'hometax.go.kr',
      'nhis.or.kr', 'hi.nhis.or.kr', 'nps.or.kr',
      'gov.kr', 'seoul.go.kr', 'gg.go.kr',
      'mois.go.kr', 'mohw.go.kr',
    ],
  },

  // ── 3. 의료·건강 ──────────────────────────────────────────────────
  {
    key: 'medical',
    name: '의료·건강',
    description: '진료 예약, 건강검진, 처방전, 의료비, 예방접종 안내',
    subjectKeywords: [
      '진료 예약', '진료 예약 확인', '진료 안내', '진료 확인',
      '건강검진', '건강 검진', '검진 결과', '검진 안내', '검진 예약',
      '처방전', '처방 안내', '처방 완료',
      '의료비', '진료비', '병원비',
      '예방접종', '접종 안내', '백신 접종',
      '입원 안내', '퇴원 안내', '수술 일정', '수술 안내',
      'appointment confirmed', 'medical appointment', 'health checkup',
      'prescription', 'vaccination',
    ],
    subjectPhrases: [
      /진료\s*(예약|확인|안내)\s*(완료|됩니다)?/,
      /건강\s*(검진|결과)\s*(안내|확인|예약)/,
      /예방\s*접종\s*(안내|일정|확인|완료)/,
      /(의료비|진료비)\s*(청구|환급|안내)/,
      /(입원|퇴원|수술)\s*(안내|일정|확인)/,
      /처방\s*(전|완료|안내)\s*(발급|확인)?/,
    ],
    senderDomains: [],
  },

  // ── 4. 결제·영수증 ────────────────────────────────────────────────
  {
    key: 'payment',
    name: '결제·영수증',
    description: '결제 완료, 영수증, 청구서, 명세서, 자동이체, 환불 확인',
    subjectKeywords: [
      '결제 완료', '결제 승인', '결제 확인', '결제 실패', '결제 안내',
      '정기결제', '정기 결제', '자동결제', '자동 결제', '자동이체',
      '영수증', '청구서', '세금계산서', '거래명세서',
      '카드 명세서', '이용대금 명세서', '이용대금', '월 청구',
      '납부 완료', '납부 확인',
      '입금 확인', '입금 완료', '이체 완료',
      '환불 완료', '환불 처리', '취소 완료', '취소 확인',
      '전자세금계산서', '전자영수증',
      'invoice', 'receipt', 'payment confirmation', 'payment failed',
      'payment receipt', 'billing statement', 'refund confirmation',
      'order invoice', 'auto-pay', 'autopay',
    ],
    subjectPhrases: [
      /결제\s*(완료|승인|처리)\s*(되었|됩니다|했습니다)/,
      /[\d,]+\s*원\s*(이|가)?\s*(결제|승인|청구)\s*(완료|됨|되었)/,
      /승인\s*(번호|금액)\s*[：:]/,
      /영수증\s*(번호|발행)/,
      /세금\s*계산서\s*(발행|발송)/,
      /환불\s*(완료|처리)\s*(되었|됩니다)/,
      /청구\s*금액\s*[：:]\s*[\d,]+/,
      /자동\s*(이체|결제)\s*(완료|안내|예정)/,
      /정기\s*결제\s*(완료|안내|실패)/,
      /(카드|이용대금)\s*명세서\s*(발송|안내)/,
      /납부\s*(완료|확인)\s*(안내|알림)?/,
    ],
    senderDomains: [],
  },

  // ── 5. 주문·배송 ──────────────────────────────────────────────────
  {
    key: 'order',
    name: '주문·배송',
    description: '주문 접수, 발송 완료, 배송 조회, 도착 알림, 반품·교환',
    subjectKeywords: [
      '주문 확인', '주문 접수', '주문 완료', '주문이 접수', '주문 내역',
      '발송 완료', '발송되었', '출고 완료', '출고되었', '출고 예정',
      '배송 준비', '배송 시작', '배송 중', '배송 조회', '배송 완료',
      '배송이 시작', '배송 출발', '배송 도착', '배달 완료',
      '택배 도착', '택배 수령', '택배 배달', '도착 예정',
      '송장 번호', '운송장 번호', '운송장',
      '픽업 준비', '픽업 완료', '매장 수령',
      '반품 신청', '반품 접수', '반품 완료',
      '교환 신청', '교환 접수', '교환 완료',
      '통관 완료', '통관 진행',
      'order confirmed', 'order confirmation', 'order shipped',
      'your order', 'shipment tracking', 'tracking number',
      'out for delivery', 'delivered', 'dispatch confirmation',
      'return request', 'exchange request', 'pickup ready',
    ],
    subjectPhrases: [
      /주문\s*(번호|번)?\s*[：:\s#\[]\s*[\w\d\-]+/,
      /송장\s*(번호|번)?\s*[：:\s]\s*\d+/,
      /배송\s*(준비|시작|출발|완료|조회)\s*(안내|알림)?/,
      /(발송|출고)\s*(완료|되었|됩니다)\s*(알림|안내)?/,
      /택배\s*(도착|수령|배달)\s*(완료|예정|안내)/,
      /(구매|주문)\s*(완료|접수)\s*(되었|됩니다|감사)/,
      /반품\s*(신청|접수|완료)\s*(됩니다|되었|확인)?/,
      /교환\s*(신청|접수|완료)\s*(됩니다|되었|확인)?/,
      /픽업\s*(준비|완료)\s*(되었|됩니다|안내)?/,
    ],
    senderDomains: [],
  },

  // ── 6. 예약·예매 ──────────────────────────────────────────────────
  {
    key: 'reservation',
    name: '예약·예매',
    description: '식당, 숙박, 교통, 공연, 티켓 등 예약·예매 확인',
    subjectKeywords: [
      '예약 확인', '예약 완료', '예약이 완료', '예약 접수', '예약 안내',
      '예약 번호', '예약 내역', '예약 취소',
      '예매 확인', '예매 완료', '예매 내역', '예매 취소',
      '예매 번호', '티켓 발권', '티켓 확인',
      '체크인 안내', '체크아웃 안내',
      '탑승권', '항공권', '기차표', 'KTX', 'SRT', '버스표',
      '공연 티켓', '영화 예매', '스포츠 티켓',
      '숙박 예약', '호텔 예약',
      'booking confirmed', 'reservation confirmed', 'booking confirmation',
      'check-in', 'your reservation', 'your booking',
      'ticket confirmation', 'e-ticket',
    ],
    subjectPhrases: [
      /예약\s*(완료|확인|접수)\s*(됩니다|되었|감사)?/,
      /예매\s*(완료|확인)\s*(됩니다|되었)?/,
      /예약\s*(번호|내역)\s*[：:]/,
      /(호텔|숙소|펜션|리조트)\s*(예약|체크인)\s*(확인|완료)/,
      /(KTX|SRT|기차|버스|항공)\s*(예매|예약)\s*(완료|확인)/,
      /(영화|공연|전시|스포츠)\s*(예매|티켓)\s*(확인|완료)/,
      /탑승권\s*(발급|확인)\s*(안내)?/,
    ],
    senderDomains: [
      'booking.com', 'airbnb.com', 'agoda.com', 'expedia.com',
      'korail.com', 'letskorail.com', 'srt.co.kr',
      'yanolja.com', 'goodchoice.kr',
      'megabox.co.kr', 'cgv.co.kr', 'lottecinema.co.kr',
      'interpark.com', 'ticketlink.co.kr',
    ],
  },

  // ── 7. 구독·멤버십 ────────────────────────────────────────────────
  {
    key: 'subscription',
    name: '구독·멤버십',
    description: '스트리밍, 클라우드, 멤버십 구독 갱신·만료·확인',
    subjectKeywords: [
      '구독 갱신', '구독 확인', '구독 완료', '구독 만료', '구독 취소',
      '멤버십 갱신', '멤버십 만료', '멤버십 확인', '멤버십 취소',
      '자동 갱신 예정', '자동 갱신 완료', '자동 결제 예정',
      '이용권 만료', '이용권 갱신', '이용 기간 만료',
      '플랜 변경', '요금제 변경',
      'subscription renewed', 'subscription confirmed', 'subscription expires',
      'auto-renewal', 'membership renewed', 'plan changed',
      'your subscription', 'billing renewal',
    ],
    subjectPhrases: [
      /구독\s*(갱신|만료|확인|완료|취소)\s*(됩니다|되었|안내)?/,
      /멤버십\s*(갱신|만료|확인|취소)\s*(됩니다|되었|안내)?/,
      /자동\s*(갱신|결제)\s*(예정|완료|됩니다)/,
      /이용권\s*(만료|갱신)\s*(안내|예정)/,
      /(플랜|요금제)\s*(변경|갱신)\s*(완료|안내)/,
    ],
    senderDomains: [
      'netflix.com', 'spotify.com',
      'apple.com', 'youtube.com', 'google.com',
      'microsoft.com', 'adobe.com',
      'dropbox.com', 'notion.so',
      'coupang.com', 'wavve.com', 'tving.com',
      'watcha.com', 'laftel.net',
    ],
  },

  // ── 8. 계정·서비스 알림 ──────────────────────────────────────────
  {
    key: 'account',
    name: '계정·서비스',
    description: '가입 완료, 휴면 예고, 서비스 공지, 약관·정책 변경',
    subjectKeywords: [
      '가입 완료', '가입이 완료', '회원가입 완료', '가입을 환영',
      '계정 생성', '계정 만들기 완료', '계정 활성화',
      '휴면 계정', '휴면 전환', '휴면 안내', '장기 미사용',
      '회원 탈퇴', '탈퇴 처리', '탈퇴 완료',
      '약관 변경', '약관 개정', '개인정보 처리방침', '개인정보 보호',
      '서비스 변경', '서비스 종료', '서비스 공지', '서비스 점검',
      '시스템 점검', '점검 안내', '일시 중단',
      '정책 변경', '이용 약관', '운영 정책',
      '이용 안내', '사용 방법',
      '이메일 주소 확인', '이메일 확인 요청',
      'welcome to', 'account created', 'account deletion',
      'terms of service', 'privacy policy', 'service notice',
      'service update', 'service termination', 'maintenance notice',
    ],
    subjectPhrases: [
      /(가입|회원가입)\s*(완료|감사|환영)/,
      /휴면\s*(계정|전환|예정)\s*(안내|알림)/,
      /약관\s*(변경|개정)\s*(안내|알림)/,
      /서비스\s*(종료|변경|중단|점검)\s*(안내|예정)/,
      /시스템\s*(점검|공지)\s*(안내|예정)/,
      /탈퇴\s*(처리|완료)\s*(되었|됩니다)/,
      /개인정보\s*(처리방침|보호정책)\s*(변경|안내)/,
      /이용\s*(약관|정책)\s*(변경|개정)/,
    ],
    senderDomains: [],
  },

  // ── 9. 금융·은행 ──────────────────────────────────────────────────
  {
    key: 'finance',
    name: '금융·은행',
    description: '계좌 입출금, 카드 이용내역, 잔액, 대출·이자 등 금융 알림',
    subjectKeywords: [
      '입출금 알림', '입금 알림', '출금 알림', '이체 알림', '이체 확인',
      '계좌 입금', '계좌 출금', '계좌 이체', '계좌 개설',
      '카드 이용', '카드 이용내역', '카드 승인', '카드 이용 알림',
      '카드 발급', '카드 배송',
      '잔액 안내', '잔액 알림', '잔액 부족',
      '대출 안내', '대출 신청', '대출 승인', '대출 상환',
      '이자 안내', '이자 납부', '이자 발생',
      '신용점수', '신용등급 변경', '신용 조회',
      '주식', '펀드', '투자', '수익률',
      'transaction alert', 'bank statement', 'account statement',
      'account balance', 'card transaction', 'wire transfer',
    ],
    subjectPhrases: [
      /[가-힣]+(은행|카드|증권|투자|페이)\s*(입금|출금|이체|이용|승인)\s*(알림|안내|완료)/,
      /카드\s*(이용|승인)\s*(내역|알림|안내)/,
      /[\d,]+원\s*(입금|출금|이체)\s*(알림|완료|됨)/,
      /계좌\s*(잔액|입금|출금|개설)\s*(안내|알림)/,
      /이자\s*(납부|발생|안내)/,
      /(대출|상환)\s*(신청|승인|완료|안내)/,
    ],
    senderDomains: [],
  },

  // ── 10. SNS·커뮤니티 ─────────────────────────────────────────────
  {
    key: 'social',
    name: 'SNS·커뮤니티',
    description: '좋아요, 댓글, 팔로우, 멘션 등 소셜 미디어 활동 알림',
    subjectKeywords: [
      '좋아요를 눌렀', '회원님의 게시물', '댓글을 달았', '팔로우하기 시작했',
      '새 팔로워', '새로운 팔로워', '팔로워가 생겼',
      '멘션했습니다', '태그했습니다',
      '새 메시지가', '새로운 메시지',
      'liked your', 'commented on your', 'started following you',
      'new follower', 'mentioned you', 'tagged you',
      'replied to your', 'reacted to your',
    ],
    subjectPhrases: [
      /회원님?의\s*(게시물|사진|동영상|댓글)\s*(에|을|를)?\s*(좋아|댓글|공유)/,
      /회원님?을\s*팔로우하기\s*시작했/,
      /(님|유저)\s*(이|가)\s*(언급|멘션|태그)했/,
      /새\s*(팔로워|댓글|좋아요|메시지)\s*(알림)?/,
      /\d+명이\s*(좋아요|댓글|반응)/,
    ],
    senderDomains: [
      'facebookmail.com', 'fb.com',
      'instagram.com', 'mail.instagram.com',
      'twitter.com', 'x.com',
      'linkedin.com', 'e.linkedin.com',
      'notifications.youtube.com',
      'discord.com',
      'notifications.github.com',
      'kakaostory.com',
      'band.us', 'noreply.band.us',
    ],
  },

  // ── 11. 이벤트·행사 ───────────────────────────────────────────────
  {
    key: 'event',
    name: '이벤트·행사',
    description: '세미나, 웨비나, 컨퍼런스, 행사 참가 신청·확인·초대',
    subjectKeywords: [
      '참가 신청', '참가 확인', '참가 완료', '신청이 완료', '신청 완료',
      '등록 완료', '행사 등록',
      '세미나', '웨비나', '컨퍼런스', '포럼', '박람회',
      '강연 안내', '강연 초대', '초대장',
      'webinar', 'seminar', 'conference',
      'registration confirmed', 'you are registered', 'event reminder',
      'you are invited',
    ],
    subjectPhrases: [
      /(세미나|웨비나|컨퍼런스|행사|포럼)\s*(초대|안내|신청|확인|알림)/,
      /참가\s*(신청|접수|확인)\s*(완료|됩니다|되었)/,
      /귀하를\s*(초대|초청)/,
      /(강연|행사)\s*(일정|안내)\s*[：:]/,
    ],
    senderDomains: [
      'eventbrite.com', 'zoom.us', 'meetup.com',
    ],
  },

  // ── 12. 교육·학습 ─────────────────────────────────────────────────
  {
    key: 'education',
    name: '교육·학습',
    description: '수강 신청, 강의, 과제 마감, 성적 발표, 수료 등 학습 알림',
    subjectKeywords: [
      '수강 신청', '수강 확인', '수강 완료', '강의 시작', '강의 안내',
      '과제 제출', '과제 마감', '시험 일정', '시험 안내',
      '성적 확인', '성적 발표', '성적 공지',
      '수료 완료', '수료증', '이수 완료',
      '합격 안내', '합격 통보', '불합격 안내',
      'assignment due', 'grade released', 'enrollment confirmed',
      'course reminder', 'certificate', 'completion certificate',
    ],
    subjectPhrases: [
      /수강\s*(신청|확인|완료)\s*(됩니다|되었|감사)/,
      /과제\s*(제출|마감)\s*(알림|안내|D-\d+)/,
      /성적\s*(발표|확인|공지)\s*(안내|알림)?/,
      /(합격|불합격)\s*(안내|통보|결과|통지)/,
      /수료\s*(완료|증명서|축하)/,
    ],
    senderDomains: [
      'coursera.org', 'udemy.com', 'edx.org',
      'inflearn.com', 'fastcampus.co.kr',
    ],
  },
];

module.exports = { CATEGORIES };
