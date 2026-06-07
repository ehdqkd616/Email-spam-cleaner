/**
 * 지능형 메일 분류 엔진
 *
 * 단순 키워드 매칭의 한계를 극복하기 위해
 * 1단계: 광고 감지 (강신호 + 약신호 scoring + 트랜잭션 보호)
 * 2단계: 카테고리 분류 (광고가 아닌 경우에만 실행)
 */

// ── 1. 광고 확정 신호 ─────────────────────────────────────────────
// 하나라도 매칭 → 광고로 확정
const AD_DEFINITE = [
  /\[광고\]/,                                          // 법정 광고 표기 (정보통신망법)
  /\[AD\]/i,
  /\d+\s*%\s*(할인|off|OFF|세일|SALE|절약)/,          // 할인율 표현
  /최대\s*\d+\s*%/,                                    // 최대 N%
  /\d+[만천]\s*원\s*(할인|적립|증정|지원|쿠폰)/,       // N만원 할인/증정
  /(오늘|금일|이번\s*주|당일)\s*만\s*(한정|적용|유효|특가|가격)/, // 시간 압박
  /마감\s*(임박|D-\d+)/,                               // 마감 임박
  /선착순\s*\d+\s*(명|인|개)/,                         // 선착순 N명
  /한정\s*(수량|판매|기간)\s*(마감|임박|종료)/,         // 한정 판매 마감
  /수신\s*거부\s*(링크|하기|안내|방법)/,               // 수신거부 (본문 안내)
  /광고\s*성?\s*(메일|정보|수신)/,
  /무료\s*(배송|증정|체험)\s*(이벤트|혜택|쿠폰)/,      // 무료 + 이벤트 복합
  /할인\s*코드|쿠폰\s*코드|프로모션\s*코드/,           // 할인/쿠폰 코드
  /unsubscribe/i,                                      // 영문 수신거부
];

// ── 2. 광고 약신호 (점수 합산 → 임계값 초과 시 광고 판정) ────────
const AD_SCORED = [
  { re: /혜택/,                  score: 1   },
  { re: /이벤트/,                score: 1   },
  { re: /쿠폰/,                  score: 1.5 },
  { re: /포인트\s*(적립|증정|지급)/, score: 1.5 },
  { re: /캐시백/,                score: 2   },
  { re: /리워드/,                score: 1.5 },
  { re: /사은품/,                score: 2   },
  { re: /증정품/,                score: 2   },
  { re: /무료\s*(배송|제공)/,    score: 1.5 },
  { re: /프로모션/,              score: 2   },
  { re: /특가/,                  score: 2   },
  { re: /특별\s*(혜택|가격|할인)/, score: 2 },
  { re: /단독\s*(혜택|할인|특가)/, score: 2 },
  { re: /지금\s*바로/,           score: 1   },
  { re: /놓치지\s*마/,           score: 2   },
  { re: /한정\s*(수량|기간)/,    score: 1.5 },
  { re: /[★☆▶◆◇■□]/,           score: 0.5 },  // 마케팅용 특수문자
  { re: /!{2,}/,                 score: 0.5 },   // 다중 느낌표
  { re: /VIP\s*(전용|고객|혜택)/, score: 1.5 },
  { re: /구독\s*(혜택|서비스)/,  score: 1   },
  { re: /멤버십\s*(혜택|특가)/,  score: 1.5 },
  { re: /newsletter/i,           score: 1.5 },
  { re: /\d+%/,                  score: 0.5 },   // 퍼센트 (약한 신호)
];

// ── 3. 트랜잭션 보호 패턴 ────────────────────────────────────────
// 하나라도 매칭 → 실제 알림/거래 메일 → 광고 판정 완전 취소
const TRANSACTIONAL_SHIELDS = [
  // 결제 완료 (과거형·완료형)
  /결제\s*(완료|승인|처리)\s*(되었|됩니다|했습니다)/,
  /[\d,]+\s*원\s*(이|가)?\s*(결제|승인|청구)\s*(완료|됨|되었)/,
  /결제\s*금액\s*[：:]\s*[\d,]+/,
  /승인\s*(번호|금액)\s*[：:]/,
  /영수증\s*(번호|발행)\s*[：:]/,
  /세금\s*계산서\s*(발행|발송)/,
  /환불\s*(완료|처리)\s*(되었|됩니다)/,

  // 인증·보안 (구체적 수치 포함)
  /인증\s*(번호|코드)\s*[：:\s]\s*\d{4,}/,
  /OTP\s*[：:\s]\s*\d{4,}/,
  /임시\s*비밀번호\s*[：:]/,
  /보안\s*코드\s*[：:\s]\s*\d{4,}/,
  /새\s*(기기|환경|브라우저|위치)\s*(에서|로)\s*(로그인|접속)/,
  /로그인\s*(시도|알림|됨|하셨)/,
  /비밀번호\s*(변경|재설정)\s*(완료|됩니다)/,
  /계정\s*(잠금|정지|비활성화)/,

  // 주문·배송 (구체적 번호 포함)
  /주문\s*(번호|접수|확인)\s*[：:\s#\[]\s*[\w\d\-]+/,
  /송장\s*(번호|번)?\s*[：:\s]\s*\d+/,
  /배송\s*(조회|완료)\s*(번호|정보|안내)/,
  /택배\s*(도착|수령|배달)\s*(완료|예정|안내)/,

  // 계정 고지 (구체적 행동 포함)
  /귀하의\s*(계정|아이디|이메일)\s*(에서|으로|이|가)/,
  /고객님의\s*(계정|주문|결제)\s*(정보|내역|상태)/,
  /가입\s*(완료|확인)\s*(되었|됩니다|감사)/,

  // 금융·은행 알림 (구체적 금액·계좌 포함)
  /[가-힣]+(은행|카드|증권|투자)\s*(입금|출금|이체|이용|승인)\s*(알림|완료)/,
  /카드\s*(이용|승인)\s*(내역|알림)/,
  /[\d,]+원\s*(입금|출금|이체)\s*(알림|완료|됨)/,
  /계좌\s*(잔액|입금|출금)\s*(안내|알림)/,

  // 이벤트·행사 참가 확인
  /참가\s*(신청|접수|확인)\s*(완료|됩니다|되었)/,
  /(세미나|웨비나|컨퍼런스|행사)\s*(신청|참가)\s*(완료|확인)/,

  // 교육·학습 알림
  /수강\s*(신청|확인)\s*(완료|됩니다|되었)/,
  /성적\s*(발표|확인|공지)\s*(안내|알림)/,
  /(합격|불합격)\s*(안내|통보|결과|통지)/,
  /수료\s*(완료|증명서)/,
  /과제\s*(제출|마감)\s*(알림|안내)/,

  // 예약·예매 확인
  /예약\s*(완료|확인|접수)\s*(됩니다|되었|감사)?/,
  /예매\s*(완료|확인)\s*(됩니다|되었)?/,
  /(KTX|SRT|기차|버스|항공|호텔|숙소)\s*(예매|예약)\s*(완료|확인)/,
  /탑승권\s*(발급|확인)/,

  // 구독·멤버십 갱신·만료
  /구독\s*(갱신|만료|완료|취소)\s*(됩니다|되었|안내)?/,
  /멤버십\s*(갱신|만료|취소)\s*(됩니다|되었|안내)?/,
  /자동\s*(갱신|결제)\s*(예정|완료|됩니다)/,

  // 의료·건강 알림
  /진료\s*(예약|확인|안내)\s*(완료|됩니다)?/,
  /건강\s*(검진|결과)\s*(안내|확인|예약)/,
  /예방\s*접종\s*(안내|일정|완료)/,

  // 보안 인증 보완
  /본인\s*(인증|확인)\s*(완료|요청)/,
  /(이메일|전화번호)\s*(인증|확인)\s*(요청|완료)/,
  /2단계\s*인증\s*(설정|알림)/,

  // 결제 보완
  /자동\s*(이체|결제)\s*(완료|안내|예정)/,
  /정기\s*결제\s*(완료|안내|실패)/,
  /(카드|이용대금)\s*명세서\s*(발송|안내)/,

  // 공공기관 고지
  /(재산세|자동차세|지방세|소득세)\s*(납부|고지)/,
  /전자\s*(고지서|납부)\s*(안내|발송)/,
  /(건강보험|국민연금|고용보험)\s*(안내|납부|고지)/,
];

// ── 4. 마케팅 발신 플랫폼 패턴 ──────────────────────────────────
// 이 도메인에서 오면 광고 점수 +2.5
const MARKETING_SENDERS = [
  /stibee\.com/i,
  /mailchimp\./i,
  /sendinblue\./i,
  /campaign\./i,
  /em\.mktg\./i,
  /marketing\.\w+/i,
  /newsletter\.\w+/i,
  /promo\.\w+/i,
  /bulk\.mail/i,
  /smtp\d+\./i,
  /mailing\.\w+/i,
  /mass\.mail/i,
];

// ── 핵심 API ─────────────────────────────────────────────────────

/**
 * 이메일이 광고인지 분석
 * @param {string} subject 제목
 * @param {string} from    발신자
 * @returns {{ isAd: boolean, confidence: number }}
 */
function detectAd(subject, from) {
  const subj   = subject || '';
  const sender = from    || '';

  // 트랜잭션 보호: 실제 알림 메일이면 광고 아님
  if (TRANSACTIONAL_SHIELDS.some((p) => p.test(subj))) {
    return { isAd: false, confidence: 0 };
  }

  // 강신호: 하나라도 매칭 → 광고 확정
  if (AD_DEFINITE.some((p) => p.test(subj))) {
    return { isAd: true, confidence: 1.0 };
  }

  // 약신호 점수 계산
  let score = 0;
  for (const { re, score: s } of AD_SCORED) {
    if (re.test(subj)) score += s;
  }

  // 마케팅 플랫폼 발신자
  if (MARKETING_SENDERS.some((p) => p.test(sender))) score += 2.5;

  // 임계값: 3.0 이상이면 광고
  return { isAd: score >= 3.0, confidence: Math.min(score / 5, 1.0) };
}

/**
 * 카테고리 분류
 * - 광고 메일은 null 반환 (카테고리 분류 안 함)
 * - 비광고 메일은 첫 번째 매칭 카테고리 반환
 *
 * @param {string} subject
 * @param {string} from
 * @param {Array}  categories  CATEGORIES 배열
 * @returns {object|null}
 */
function matchCategory(subject, from, categories) {
  const { isAd } = detectAd(subject, from);
  if (isAd) return null;

  const subj   = (subject || '').toLowerCase();
  const sender = (from    || '').toLowerCase();

  for (const cat of categories) {
    const kwHit     = (cat.subjectKeywords || []).some((kw) => subj.includes(kw.toLowerCase()));
    const domainHit = (cat.senderDomains   || []).some((d)  => sender.includes(d.toLowerCase()));
    const phraseHit = (cat.subjectPhrases  || []).some((p)  => p.test(subj));

    if (kwHit || domainHit || phraseHit) return cat;
  }
  return null;
}

module.exports = { detectAd, matchCategory };
