// CAU 학교 이메일 전용 분류 카테고리
// 개인 메일 categories.js와 별도로 학사 중심으로 구성

const CAU_CATEGORIES = [
  {
    key: 'academic',
    name: '학사공지',
    description: '수강신청, 성적, 졸업, 학점, 장학 관련',
    subjectKeywords: [
      '수강', '성적', '졸업', '학점', '장학', '등록금', '납부',
      '휴학', '복학', '학사', '전공', '교양', '시간표',
    ],
    senderDomains: ['cau.ac.kr'],
  },
  {
    key: 'notice',
    name: '학교공지',
    description: '학교 및 학과 공지사항, 행사 안내',
    subjectKeywords: [
      '[공지]', '[안내]', '[알림]', '공지사항', '학생처', '교무처',
      '취업', '인턴', '채용', '설명회', '특강',
    ],
    senderDomains: ['cau.ac.kr'],
  },
  {
    key: 'security',
    name: '보안알림',
    description: '로그인 알림, Microsoft 보안 관련',
    subjectKeywords: [
      '로그인', '비밀번호', '보안', '인증', '새로운 환경',
      'login', 'password', 'security', 'verify',
    ],
    senderDomains: [
      'microsoft.com', 'microsoftonline.com',
      'account.microsoft.com', 'live.com',
    ],
  },
];

module.exports = { CAU_CATEGORIES };
