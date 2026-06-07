const chalk = require('chalk');
const ora   = require('ora');
const { FILTER_DEFINITIONS } = require('./queries');
const logger = require('../logger');

async function setupFilters(gmailClient) {
  console.log(chalk.bold.cyan('\n⚙️  자동 필터 설정\n'));
  const existing = await gmailClient.listFilters();
  console.log(chalk.gray(`현재 등록된 필터: ${existing.length}개\n`));
  logger.info('FILTER', `[Gmail] 자동 필터 설정 시작 — 기존 ${existing.length}개`, true);

  let created = 0; let failed = 0;
  for (const def of FILTER_DEFINITIONS) {
    const spinner = ora(def.name).start();
    try {
      await gmailClient.createFilter(def.criteria, def.action);
      spinner.succeed(chalk.green(def.name));
      logger.success('FILTER', `[Gmail] 필터 생성: ${def.name}`, true);
      created++;
    } catch (err) {
      if (err.code === 409 || err.message?.includes('already exists')) {
        spinner.warn(chalk.yellow(`이미 존재: ${def.name}`));
        logger.warn('FILTER', `[Gmail] 필터 이미 존재: ${def.name}`, true);
      } else {
        spinner.fail(chalk.red(`실패: ${def.name}  — ${err.message}`));
        logger.error('FILTER', `[Gmail] 필터 생성 실패: ${def.name} — ${err.message}`, true);
        failed++;
      }
    }
  }
  console.log(chalk.bold(`\n필터 설정 완료 — 생성: ${created}개  실패: ${failed}개\n`));
  logger.success('FILTER', `[Gmail] 자동 필터 설정 완료 — 생성: ${created}개 실패: ${failed}개`, true);
}

module.exports = { setupFilters };
