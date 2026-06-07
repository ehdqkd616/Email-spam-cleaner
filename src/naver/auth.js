// Naver Mail 인증 — 실행 시마다 터미널에서 직접 입력
// 비밀번호는 *** 마스킹 처리되며 디스크에 저장되지 않습니다.
//
// ※ 네이버는 2025년 6월부터 IMAP 접근 시 일반 비밀번호를 차단합니다.
//    반드시 아래 순서로 애플리케이션 비밀번호를 먼저 발급하세요:
//
//   1. nid.naver.com 접속 → 보안 설정 → 2단계 인증 활성화
//   2. 애플리케이션 비밀번호 관리 → 새 비밀번호 생성
//   3. 생성된 비밀번호를 아래 입력란에 사용 (일반 비밀번호 아님!)
//   4. mail.naver.com → 환경설정 → POP3/IMAP 설정 → IMAP 사용함

const inquirer = require('inquirer');
const chalk = require('chalk');

// isRetry: 재시도 여부 (틀렸을 때 호출 시 true)
async function getNaverCredentials(isRetry = false) {
  if (isRetry) {
    console.log(chalk.red('\n  ❌ 로그인 실패 — 아이디 또는 앱 비밀번호가 올바르지 않습니다.'));
    console.log(chalk.yellow('  • 일반 비밀번호가 아닌 애플리케이션 비밀번호를 입력했는지 확인하세요.'));
    console.log(chalk.yellow('  • 발급: nid.naver.com → 보안 설정 → 2단계 인증 → 애플리케이션 비밀번호 관리\n'));
  } else {
    console.log(chalk.gray('  Naver Mail IMAP 연결 정보를 입력하세요.'));
    console.log(chalk.yellow('  ⚠  비밀번호는 일반 비밀번호가 아닌 애플리케이션 비밀번호를 입력하세요.'));
    console.log(chalk.gray('     발급: nid.naver.com → 보안 설정 → 2단계 인증 → 애플리케이션 비밀번호 관리\n'));
    console.log(chalk.gray('  입력값은 메모리에만 유지되며 파일에 저장되지 않습니다.\n'));
  }

  const { user, password } = await inquirer.prompt([
    {
      type: 'input',
      name: 'user',
      message: 'Naver 아이디 (아이디 또는 전체 이메일):',
      validate: (v) => v.trim().length > 0 ? true : '아이디를 입력해주세요.',
    },
    {
      type: 'password',
      name: 'password',
      message: '애플리케이션 비밀번호:',
      mask: '*',
      validate: (v) => v.length > 0 ? true : '비밀번호를 입력해주세요.',
    },
  ]);

  // @naver.com 미입력 시 자동 추가
  const email = user.trim().includes('@') ? user.trim() : `${user.trim()}@naver.com`;

  return { user: email, password };
}

module.exports = { getNaverCredentials };
