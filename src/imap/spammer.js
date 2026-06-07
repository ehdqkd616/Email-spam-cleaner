const inquirer = require('inquirer');
const chalk    = require('chalk');
const ora      = require('ora');
const { createCleaner } = require('./cleaner');
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

function createSpammer({ QUERIES, buildCriteria }) {
  const { scanAll } = createCleaner({ QUERIES, buildCriteria });

  async function markSpam(client, selectedKeys, readFilter) {
    const results = await scanAll(client, selectedKeys, readFilter);
    const idSet = new Set();
    for (const r of Object.values(results)) {
      if (!r.error) r.messages.forEach((m) => idSet.add(m.id));
    }
    const ids = [...idSet];
    if (!ids.length) { console.log(chalk.green('\n✅ 스팸 처리할 메일이 없습니다.\n')); return 0; }

    logger.info('SPAM', `[IMAP] 스팸 처리 시작 — ${ids.length}개`, true);
    const spinner = ora(`${ids.length}개 메일 스팸 처리 중...`).start();
    try {
      const count = await client.markAsSpam(ids);
      spinner.succeed(chalk.green(`✅ ${count}개 메일을 스팸함으로 이동했습니다.`));
      logger.success('SPAM', `[IMAP] 스팸 처리 완료 — ${count}개`, true);
      return count;
    } catch (err) {
      logger.error('SPAM', `[IMAP] 스팸 처리 오류: ${err.message}`, true);
      spinner.fail(`오류 발생: ${err.message}`); throw err;
    }
  }

  async function blockSenders(client, selectedKeys, readFilter) {
    console.log(chalk.bold.cyan('\n🔒 발신자 수신 차단\n'));

    // IMAP은 서버 필터 미지원 — 발신자 목록 출력 안내
    console.log(chalk.yellow(
      '⚠  IMAP은 서버 사이드 차단 필터를 지원하지 않습니다.\n' +
      '   아래 발신자 목록을 확인 후 메일 서비스 웹에서 직접 차단 설정을 해주세요.\n'
    ));

    const senderMap = new Map();
    for (const key of selectedKeys) {
      const def = QUERIES[key];
      if (!def) continue;
      const criteria = buildCriteria(key, readFilter);
      const spinner  = ora(`[${def.name}] 발신자 수집 중...`).start();
      try {
        const messages  = await client.searchInFolder(def.folder, criteria, 300);
        const metadatas = await client.getMetadata(messages.map((m) => m.id));
        for (const msg of metadatas) {
          const from = getHeader(msg, 'From');
          if (!from) continue;
          const email   = parseEmail(from);
          const display = parseDisplay(from);
          if (senderMap.has(email)) senderMap.get(email).count++;
          else senderMap.set(email, { display, count: 1 });
        }
        spinner.succeed(`[${def.name}] 완료`);
      } catch (err) { spinner.fail(`[${def.name}] 실패: ${err.message}`); }
    }

    if (!senderMap.size) { console.log(chalk.green('수집된 발신자가 없습니다.\n')); return; }

    const sorted = [...senderMap.entries()].sort((a, b) => b[1].count - a[1].count);
    console.log(chalk.bold(`\n발견된 발신자 목록 (총 ${sorted.length}명):\n`));
    sorted.slice(0, 30).forEach(([email, info], i) => {
      console.log(
        chalk.gray(`  ${String(i + 1).padStart(2)}. `) +
        `${info.display.slice(0, 50).padEnd(50)}  ` +
        chalk.yellow(`${info.count}개 메일`)
      );
    });
    if (sorted.length > 30) console.log(chalk.gray(`  ... 외 ${sorted.length - 30}명`));
    console.log(chalk.cyan('\n메일 서비스 웹 → 환경설정 → 스팸/수신차단 설정에 위 주소를 추가해주세요.\n'));
  }

  return { markSpam, blockSenders };
}

module.exports = { createSpammer };
