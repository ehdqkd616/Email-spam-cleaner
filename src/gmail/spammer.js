const inquirer = require('inquirer');
const chalk    = require('chalk');
const ora      = require('ora');
const { QUERIES, buildQuery } = require('./queries');
const { scanAll }             = require('./cleaner');
const logger = require('../logger');

function getHeader(msg, name) {
  return msg.payload?.headers?.find(
    (h) => h.name.toLowerCase() === name.toLowerCase()
  )?.value || '';
}

function parseEmail(raw) {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).toLowerCase().trim();
}

function parseDisplay(raw) {
  const m = raw.match(/^"?([^"<]+?)"?\s*</);
  return m ? `${m[1].trim()} <${parseEmail(raw)}>` : parseEmail(raw);
}

async function markSpam(gmailClient, selectedKeys, readFilter) {
  const results = await scanAll(gmailClient, selectedKeys, readFilter);
  const idSet = new Set();
  for (const r of Object.values(results)) {
    if (!r.error) r.messages.forEach((m) => idSet.add(m.id));
  }
  const ids = [...idSet];
  if (!ids.length) { console.log(chalk.green('\n✅ 스팸 처리할 메일이 없습니다.\n')); return 0; }

  logger.info('SPAM', `[Gmail] 스팸 처리 시작 — ${ids.length}개`, true);
  const spinner = ora(`${ids.length}개 메일 스팸 처리 중...`).start();
  try {
    const count = await gmailClient.markAsSpam(ids);
    spinner.succeed(chalk.green(`✅ ${count}개 메일을 스팸함으로 이동했습니다.`));
    logger.success('SPAM', `[Gmail] 스팸 처리 완료 — ${count}개`, true);
    return count;
  } catch (err) {
    logger.error('SPAM', `[Gmail] 스팸 처리 오류: ${err.message}`, true);
    spinner.fail(`오류 발생: ${err.message}`); throw err;
  }
}

async function blockSenders(gmailClient, selectedKeys, readFilter) {
  console.log(chalk.bold.cyan('\n🔒 발신자 차단  (스팸 자동 분류 필터 생성)\n'));
  const senderMap = new Map();

  for (const key of selectedKeys) {
    const def = QUERIES[key];
    if (!def) continue;
    const query   = buildQuery(key, readFilter);
    const spinner = ora(`[${def.name}] 발신자 수집 중...`).start();
    try {
      const messages  = await gmailClient.searchMessages(query, 300);
      const metadatas = await gmailClient.getMetadata(messages.map((m) => m.id));
      for (const msg of metadatas) {
        const from = getHeader(msg, 'From');
        if (!from) continue;
        const email   = parseEmail(from);
        const display = parseDisplay(from);
        if (senderMap.has(email)) senderMap.get(email).count++;
        else senderMap.set(email, { display, count: 1 });
      }
      spinner.succeed(`[${def.name}] ${messages.length}개 메일에서 발신자 추출 완료`);
    } catch (err) { spinner.fail(`[${def.name}] 실패: ${err.message}`); }
  }

  if (!senderMap.size) { console.log(chalk.green('\n✅ 수집된 발신자가 없습니다.\n')); return; }

  const sorted  = [...senderMap.entries()].sort((a, b) => b[1].count - a[1].count);
  const choices = sorted.map(([email, info]) => ({
    name:    `${info.display.slice(0, 48).padEnd(48)}  (${info.count}개 메일)`,
    value:   email,
    checked: true,
  }));

  const { selectedEmails } = await inquirer.prompt([{
    type: 'checkbox', name: 'selectedEmails',
    message: `차단할 발신자를 선택하세요  (총 ${sorted.length}명 발견):`,
    choices, pageSize: 15,
  }]);

  if (!selectedEmails.length) { console.log(chalk.gray('선택된 발신자가 없습니다.\n')); return; }

  const { confirm } = await inquirer.prompt([{
    type: 'confirm', name: 'confirm',
    message: chalk.yellow(`${selectedEmails.length}명의 발신자를 차단하시겠습니까?`),
    default: false,
  }]);
  if (!confirm) { console.log(chalk.gray('취소되었습니다.\n')); return; }

  logger.info('BLOCK', `[Gmail] 발신자 차단 시작 — ${selectedEmails.length}명`, true);
  console.log('');
  let created = 0; let failed = 0;
  for (const email of selectedEmails) {
    const spinner = ora(`차단 필터 생성: ${email}`).start();
    try {
      await gmailClient.createBlockFilter(email);
      spinner.succeed(chalk.green(`차단 완료: ${email}`));
      logger.success('BLOCK', `[Gmail] 차단 완료: ${email}`, true);
      created++;
    } catch (err) {
      const dup = err.code === 409 || err.message?.toLowerCase().includes('already exists');
      if (dup) {
        spinner.warn(chalk.yellow(`이미 차단됨: ${email}`));
        logger.warn('BLOCK', `[Gmail] 이미 차단됨: ${email}`, true);
      } else {
        spinner.fail(chalk.red(`실패: ${email}  — ${err.message}`));
        logger.error('BLOCK', `[Gmail] 차단 실패: ${email} — ${err.message}`, true);
        failed++;
      }
    }
  }
  console.log(chalk.bold(`\n차단 완료 — 생성: ${created}개  실패: ${failed}개`));
  logger.success('BLOCK', `[Gmail] 발신자 차단 완료 — 생성: ${created}개 실패: ${failed}개`, true);
  console.log(chalk.gray('이후 해당 발신자의 메일은 자동으로 스팸함으로 이동됩니다.\n'));
}

module.exports = { markSpam, blockSenders };
