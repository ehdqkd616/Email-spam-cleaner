const chalk = require('chalk');
const ora   = require('ora');
const { CATEGORIES }    = require('../categories');
const { matchCategory } = require('../matcher');
const logger = require('../logger');

// Gmail 검색 쿼리 생성 — 각 카테고리의 키워드 기반
// subjectPhrases(regex)는 Gmail SEARCH에서 사용 불가 → getMetadata 후 client-side 재필터링
function buildGmailQuery(cat) {
  const kwParts = cat.subjectKeywords
    .filter((kw) => kw.length >= 3)   // 너무 짧은 키워드 제외
    .map((kw) => `"${kw}"`);

  const senderPart = cat.senderDomains.length
    ? cat.senderDomains.map((d) => `from:${d}`).join(' OR ')
    : '';

  const parts = [];
  if (kwParts.length) parts.push(`subject:(${kwParts.join(' OR ')})`);
  if (senderPart)     parts.push(`(${senderPart})`);
  if (!parts.length)  return null;

  // 광고 명시 태그 제외 (Gmail SEARCH에서 처리 가능한 부분)
  return [
    `(${parts.join(' OR ')})`,
    'in:inbox',
    '-subject:[광고]',
    '-subject:[AD]',
  ].join(' ');
}

async function categorize(gmailClient) {
  console.log(chalk.bold.cyan('\n📂 자동 분류  (Gmail 라벨 적용)\n'));
  console.log(chalk.gray('  메일은 받은편지함에 그대로 유지되며 카테고리 라벨이 추가됩니다.\n'));
  logger.info('CATEGORIZE', 'Gmail 자동 분류 시작', true);
  let total = 0;

  for (const cat of CATEGORIES) {
    const query = buildGmailQuery(cat);
    if (!query) continue;

    const spinner = ora(`[${cat.name}] 검색 중...`).start();
    try {
      const messages = await gmailClient.searchMessages(query, 2000);
      if (!messages.length) {
        spinner.succeed(chalk.gray(`[${cat.name}] 해당 메일 없음`));
        logger.info('CATEGORIZE', `[Gmail][${cat.name}] 해당 메일 없음`, true);
        continue;
      }

      // Gmail SEARCH는 완전한 맥락 분석 불가 → 메타데이터 가져와서 client-side 재필터링
      spinner.text = `[${cat.name}] ${messages.length}개 발견 — 광고 필터링 중...`;
      const BATCH = 200;
      const safeIds = [];

      for (let i = 0; i < messages.length; i += BATCH) {
        const chunk    = messages.slice(i, i + BATCH).map((m) => m.id);
        const metadatas = await gmailClient.getMetadata(chunk);
        for (const msg of metadatas) {
          const subject = msg.payload?.headers?.find((h) => h.name === 'Subject')?.value || '';
          const from    = msg.payload?.headers?.find((h) => h.name === 'From')?.value    || '';
          const matched = matchCategory(subject, from, [cat]); // 해당 카테고리만 재검사
          if (matched) safeIds.push(msg.id);
        }
      }

      if (!safeIds.length) {
        spinner.succeed(chalk.gray(`[${cat.name}] 광고 필터링 후 해당 메일 없음`));
        logger.info('CATEGORIZE', `[Gmail][${cat.name}] 광고 필터링 후 해당 없음`, true);
        continue;
      }

      const filtered = messages.length - safeIds.length;
      spinner.text = `[${cat.name}] ${safeIds.length}개 — 라벨 적용 중...`;
      if (filtered > 0) spinner.text += chalk.gray(` (광고 ${filtered}개 제외)`);

      const labelId = await gmailClient.getOrCreateLabel(cat.name);
      await gmailClient.applyLabel(safeIds, labelId);

      const msg = chalk.green(`[${cat.name}] ${safeIds.length}개 라벨 적용 완료`) +
        (filtered > 0 ? chalk.gray(`  (광고 ${filtered}개 제외)`) : '');
      spinner.succeed(msg);
      logger.success('CATEGORIZE', `[Gmail][${cat.name}] ${safeIds.length}개 완료 (광고 ${filtered}개 제외)`, true);
      total += safeIds.length;

    } catch (err) {
      spinner.fail(chalk.red(`[${cat.name}] 실패: ${err.message}`));
      logger.error('CATEGORIZE', `[Gmail][${cat.name}] 실패: ${err.message}`, true);
    }
  }

  console.log(chalk.bold(`\n✅ 총 ${total}개 메일에 카테고리 라벨 적용 완료`));
  console.log(chalk.gray('  Gmail 좌측 메뉴에서 각 라벨 폴더를 확인할 수 있습니다.\n'));
  logger.success('CATEGORIZE', `Gmail 자동 분류 완료 — 총 ${total}개`, true);
}

module.exports = { categorize };
