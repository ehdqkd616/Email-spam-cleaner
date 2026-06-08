const chalk = require('chalk');
const ora   = require('ora');
const { CATEGORIES }          = require('../categories');
const { matchCategory }       = require('../matcher');
const logger = require('../logger');

const SYSTEM_FOLDERS = new Set([
  'INBOX', '휴지통', '스팸메일함', '스팸', '보낸메일함',
  '임시보관함', '내게쓴메일함', '광고메일함', '광고함',
]);

function getHeader(msg, name) {
  return msg.payload?.headers?.find(
    (h) => h.name.toLowerCase() === name.toLowerCase()
  )?.value || '';
}

async function categorize(client) {
  console.log(chalk.bold.cyan('\n📂 자동 분류  (IMAP 폴더 이동)\n'));
  logger.info('CATEGORIZE', 'IMAP 자동 분류 시작', true);

  const fetchSpinner = ora('받은편지함 전체 메시지 헤더 가져오는 중...').start();
  let metadatas;
  try {
    metadatas = await client.fetchAllMetadata('INBOX', (done, total) => {
      fetchSpinner.text = `받은편지함 메시지 가져오는 중... (${done}/${total}개)`;
    });
    fetchSpinner.succeed(`받은편지함 ${metadatas.length}개 메시지 분석 완료`);
    logger.info('CATEGORIZE', `IMAP 받은편지함 ${metadatas.length}개 메시지 로드`, true);
  } catch (err) {
    fetchSpinner.fail(`헤더 조회 실패: ${err.message}`);
    logger.error('CATEGORIZE', `IMAP 헤더 조회 실패: ${err.message}`, true);
    return;
  }

  if (!metadatas.length) {
    console.log(chalk.gray('  받은편지함에 메일이 없습니다.\n'));
    return;
  }

  // 분류별 매칭 (matcher.js의 2단계 파이프라인 사용)
  const buckets = {};
  let skippedAds = 0;

  for (const msg of metadatas) {
    const subject = getHeader(msg, 'Subject');
    const from    = getHeader(msg, 'From');
    const cat     = matchCategory(subject, from, CATEGORIES);

    if (!cat) { skippedAds++; continue; }  // 광고거나 미분류

    if (!buckets[cat.key]) buckets[cat.key] = { cat, msgs: [] };
    buckets[cat.key].msgs.push(msg);
  }

  if (skippedAds > 0) {
    console.log(chalk.gray(`  광고/미분류로 제외: ${skippedAds}개\n`));
  }
  console.log('');

  let total = 0;

  for (const { cat, msgs } of Object.values(buckets)) {
    if (!msgs.length) continue;

    const spinner = ora(`[${cat.name}] ${msgs.length}개 — 폴더로 이동 중...`).start();
    try {
      await client.createFolder(cat.name);
      await client.moveTo(msgs.map((m) => m.id), cat.name);
      spinner.succeed(chalk.green(`[${cat.name}] ${msgs.length}개 이동 완료`));
      logger.success('CATEGORIZE', `[IMAP][${cat.name}] ${msgs.length}개 이동 완료`, true);
      total += msgs.length;
    } catch (err) {
      const detail = err.responseText ? ` [${err.responseText.trim()}]` : '';
      spinner.fail(chalk.red(`[${cat.name}] 실패: ${err.message}${detail}`));
      logger.error('CATEGORIZE', `[IMAP][${cat.name}] 실패: ${err.message}${detail}`, true);
      // Command failed 후 서버가 BYE를 비동기 전송 가능 → 즉시 재연결로 다음 카테고리 보호
      try {
        await client.reconnect();
        logger.info('CATEGORIZE', '[IMAP] 재연결 성공', true);
      } catch (reconnErr) {
        logger.error('CATEGORIZE', `[IMAP] 재연결 실패: ${reconnErr.message}`, true);
      }
    }
  }

  // 매칭 없는 카테고리 표시
  for (const cat of CATEGORIES) {
    if (!buckets[cat.key]) {
      console.log(chalk.gray(`  [${cat.name}] 해당 메일 없음`));
      logger.info('CATEGORIZE', `[IMAP][${cat.name}] 해당 메일 없음`, true);
    }
  }

  console.log(chalk.bold(`\n✅ 총 ${total}개 메일 분류 완료`));
  console.log(chalk.gray('  메일 서비스 좌측 폴더 목록에서 확인할 수 있습니다.\n'));
  logger.success('CATEGORIZE', `IMAP 자동 분류 완료 — 총 ${total}개`, true);
}

async function cleanupOldFolders(client) {
  console.log(chalk.bold.cyan('\n🔄 이전 형식 폴더 정리\n'));
  logger.info('CATEGORIZE', 'IMAP 이전 폴더 정리 시작', true);
  const allFolders = await client.listFolders();
  const oldFolders = allFolders.filter((f) => f.includes('[') && !SYSTEM_FOLDERS.has(f));

  if (!oldFolders.length) {
    console.log(chalk.green('  정리할 이전 형식 폴더가 없습니다.\n'));
    logger.info('CATEGORIZE', 'IMAP 정리할 이전 형식 폴더 없음', true);
    return false;
  }

  console.log(chalk.yellow(`  발견된 이전 형식 폴더 ${oldFolders.length}개:`));
  oldFolders.forEach((f) => console.log(chalk.gray(`    • ${f}`)));
  console.log('');
  logger.info('CATEGORIZE', `IMAP 이전 형식 폴더 ${oldFolders.length}개 발견`, true);

  const sorted = [...oldFolders].sort((a, b) => b.split('/').length - a.split('/').length);
  let restored = 0;

  for (const folder of sorted) {
    const spinner = ora(`  ${folder} 처리 중...`).start();
    try {
      const messages = await client.searchInFolder(folder, {}, 9999);
      if (messages.length) {
        await client.moveTo(messages.map((m) => m.id), 'INBOX');
        restored += messages.length;
      }
      await client.deleteFolder(folder);
      spinner.succeed(
        chalk.green(`  ${folder} 삭제`) +
        (messages.length ? chalk.gray(`  (메일 ${messages.length}개 받은편지함 복구)`) : '')
      );
      logger.success('CATEGORIZE', `IMAP 폴더 삭제: ${folder} (복구 ${messages.length}개)`, true);
    } catch (err) {
      spinner.fail(chalk.red(`  ${folder} 실패: ${err.message}`));
      logger.error('CATEGORIZE', `IMAP 폴더 삭제 실패: ${folder} — ${err.message}`, true);
    }
  }

  console.log(chalk.bold(`\n✅ 정리 완료 — 메일 ${restored}개 받은편지함으로 복구됨`));
  console.log(chalk.cyan('  자동 분류를 다시 실행하면 새 폴더로 재정리됩니다.\n'));
  logger.success('CATEGORIZE', `IMAP 폴더 정리 완료 — 메일 ${restored}개 복구됨`, true);
  return true;
}

module.exports = { categorize, cleanupOldFolders };
