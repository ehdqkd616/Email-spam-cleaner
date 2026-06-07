// Nate Mail 인증 — 실행 시마다 터미널에서 직접 입력
// 비밀번호는 *** 마스킹 처리되며 디스크에 저장되지 않습니다.
//
// Nate Mail IMAP 사용 전 설정:
//   mail.nate.com → 설정(톱니바퀴) → 모바일 관리 → IMAP 사용 설정

const inquirer = require('inquirer');
const chalk    = require('chalk');

async function getNateCredentials(isRetry = false) {
  if (isRetry) {
    console.log(chalk.red('\n  ❌ 로그인 실패 — 아이디 또는 비밀번호가 올바르지 않습니다.'));
    console.log(chalk.yellow('  • IMAP이 활성화되어 있는지 확인하세요.'));
    console.log(chalk.yellow('  • mail.nate.com → 설정 → 모바일 관리 → IMAP 사용\n'));
  } else {
    console.log(chalk.gray('  Nate Mail IMAP 연결 정보를 입력하세요.'));
    console.log(chalk.gray('  입력값은 메모리에만 유지되며 파일에 저장되지 않습니다.\n'));
    console.log(chalk.gray('  IMAP 사용 전 설정: mail.nate.com → 설정 → 모바일 관리 → IMAP 사용\n'));
  }

  const { user, password } = await inquirer.prompt([
    {
      type: 'input',
      name: 'user',
      message: 'Nate 아이디 (아이디 또는 전체 이메일):',
      validate: (v) => v.trim().length > 0 ? true : '아이디를 입력해주세요.',
    },
    {
      type: 'password',
      name: 'password',
      message: '비밀번호:',
      mask: '*',
      validate: (v) => v.length > 0 ? true : '비밀번호를 입력해주세요.',
    },
  ]);

  const email = user.trim().includes('@') ? user.trim() : `${user.trim()}@nate.com`;
  return { user: email, password };
}

module.exports = { getNateCredentials };
