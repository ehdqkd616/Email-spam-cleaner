// CAU 전용 자동 분류 — 학교 카테고리 + 공통 IMAP 분류 로직 사용

const chalk = require('chalk');
const ora   = require('ora');
const { CAU_CATEGORIES }           = require('./categories');
const { categorize: imapCategorize, cleanupOldFolders } = require('../imap/categorizer');

function getHeader(msg, name) {
  return msg.payload?.headers?.find(
    (h) => h.name.toLowerCase() === name.toLowerCase()
  )?.value || '';
}

function matchesCategory(msg, cat) {
  const subject = getHeader(msg, 'Subject').toLowerCase();
  const from    = getHeader(msg, 'From').toLowerCase();
  for (const kw of cat.subjectKeywords) {
    if (subject.includes(kw.toLowerCase())) return true;
  }
  for (const domain of cat.senderDomains) {
    if (from.includes(domain.toLowerCase())) return true;
  }
  return false;
}

async function categorize(client) {
  console.log(chalk.bold.cyan('\n📂 CAU 자동 분류  (IMAP 폴더 이동)\n'));
  console.log(chalk.gray('  받은편지함의 메일이 학교 카테고리 폴더로 이동됩니다.\n'));

  const fetchSpinner = ora('받은편지함 전체 메시지 헤더 가져오는 중...').start();
  let metadatas;
  try {
    metadatas = await client.fetchAllMetadata('INBOX');
    fetchSpinner.succeed(`받은편지함 ${metadatas.length}개 메시지 분석 완료`);
  } catch (err) {
    fetchSpinner.fail(`헤더 조회 실패: ${err.message}`);
    return;
  }

  if (!metadatas.length) {
    console.log(chalk.gray('  받은편지함에 메일이 없습니다.\n'));
    return;
  }

  console.log('');
  let total = 0;

  for (const cat of CAU_CATEGORIES) {
    const matched = metadatas.filter((msg) => matchesCategory(msg, cat));
    if (!matched.length) {
      console.log(chalk.gray(`  [${cat.name}] 해당 메일 없음`));
      continue;
    }

    const spinner = ora(`[${cat.name}] ${matched.length}개 — 폴더로 이동 중...`).start();
    try {
      await client.createFolder(cat.name);
      await client.moveTo(matched.map((m) => m.id), cat.name);
      spinner.succeed(chalk.green(`[${cat.name}] ${matched.length}개 이동 완료`));
      total += matched.length;
    } catch (err) {
      spinner.fail(chalk.red(`[${cat.name}] 실패: ${err.message}`));
    }
  }

  console.log(chalk.bold(`\n✅ 총 ${total}개 메일 분류 완료`));
  console.log(chalk.gray('  Outlook 좌측 폴더 목록에서 확인할 수 있습니다.\n'));
}

module.exports = { categorize, cleanupOldFolders };
