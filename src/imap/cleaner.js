const chalk = require('chalk');
const ora   = require('ora');
const { PRESERVATION } = require('../queries');
const logger = require('../logger');

function getHeader(msg, name) {
  return msg.payload?.headers?.find(
    (h) => h.name.toLowerCase() === name.toLowerCase()
  )?.value || '';
}

function checkPreservation(msg) {
  const subject = getHeader(msg, 'Subject').toLowerCase();
  const from    = getHeader(msg, 'From').toLowerCase();
  for (const kw of PRESERVATION.subjectKeywords) {
    if (subject.includes(kw.toLowerCase())) return `제목 키워드: "${kw}"`;
  }
  for (const domain of PRESERVATION.senderDomains) {
    if (from.includes(domain.toLowerCase())) return `발신 도메인: "${domain}"`;
  }
  return null;
}

// QUERIES와 buildCriteria를 받아 provider에 독립적인 cleaner 반환
function createCleaner({ QUERIES, buildCriteria }) {

  async function scanAll(client, selectedKeys, readFilter = 'is:unread') {
    const results = {};
    for (const key of selectedKeys) {
      const def = QUERIES[key];
      if (!def) continue;
      const criteria = buildCriteria(key, readFilter);
      const spinner  = ora(`[${def.name}] 검색 중...`).start();
      try {
        const messages = await client.searchInFolder(def.folder, criteria);
        spinner.succeed(`[${def.name}] ${chalk.yellow(messages.length + '개')} 발견`);
        logger.info('SCAN', `[IMAP][${def.name}] ${messages.length}개 발견`, true);
        results[key] = { ...def, messages };
      } catch (err) {
        const msg = err.message?.includes('does not exist') || err.responseText?.includes('NO')
          ? `폴더 "${def.folder}"를 찾을 수 없습니다.`
          : err.message;
        spinner.fail(`[${def.name}] 검색 실패: ${msg}`);
        logger.error('SCAN', `[IMAP][${def.name}] 검색 실패: ${msg}`, true);
        results[key] = { ...def, messages: [], error: msg };
      }
    }
    return results;
  }

  async function dryRun(client, selectedKeys, readFilter) {
    console.log(chalk.bold.cyan('\n📋 미리보기 모드  (삭제 없음)\n'));
    const results = await scanAll(client, selectedKeys, readFilter);
    let grandTotal = 0;
    const warnings = [];

    for (const result of Object.values(results)) {
      if (result.error || !result.messages.length) continue;
      grandTotal += result.messages.length;

      const spinner = ora(`[${result.name}] 샘플 분석 중...`).start();
      const samples = await client.getMetadata(result.messages.slice(0, 15).map((m) => m.id));
      spinner.stop();

      console.log(chalk.bold(`\n▶ ${result.name}  (총 ${result.messages.length}개)`));
      for (const msg of samples.slice(0, 5)) {
        const subject = getHeader(msg, 'Subject') || '(제목 없음)';
        const from    = getHeader(msg, 'From')    || '(발신자 없음)';
        const reason  = checkPreservation(msg);
        if (reason) {
          warnings.push({ subject, reason });
          console.log(chalk.red(`  ⚠  ${subject.slice(0, 55)}`));
          console.log(chalk.red(`     보존 경고: ${reason}`));
        } else {
          console.log(chalk.gray(`  ✉  ${subject.slice(0, 55)}`));
          console.log(chalk.gray(`     ${from.slice(0, 45)}`));
        }
      }
      if (result.messages.length > 5)
        console.log(chalk.gray(`  ... 외 ${result.messages.length - 5}개`));
    }

    console.log(chalk.bold(`\n📊 삭제 대상 합계: ${grandTotal}개`));
    if (warnings.length) {
      console.log(chalk.red(`\n⚠  보존 경고 ${warnings.length}건 — 실제 삭제 전 반드시 확인하세요.`));
      warnings.forEach((w) => console.log(chalk.yellow(`   • ${w.subject.slice(0, 50)}  [${w.reason}]`)));
    }
    console.log('');
    return { results, grandTotal, warnings };
  }

  async function execute(client, selectedKeys, mode = 'trash', readFilter) {
    const results = await scanAll(client, selectedKeys, readFilter);
    const idSet = new Set();
    for (const r of Object.values(results)) {
      if (!r.error) r.messages.forEach((m) => idSet.add(m.id));
    }
    const allIds = [...idSet];
    if (!allIds.length) { console.log(chalk.green('\n✅ 처리할 메일이 없습니다.\n')); return 0; }

    const metaSpinner = ora(`${allIds.length}개 메일 보존 여부 확인 중...`).start();
    const metadatas = await client.getMetadata(allIds);
    metaSpinner.stop();

    const safeIds = [];
    const skipped = [];
    for (const meta of metadatas) {
      const reason = checkPreservation(meta);
      if (reason) skipped.push({ subject: getHeader(meta, 'Subject'), reason });
      else safeIds.push(meta.id);
    }

    if (skipped.length) {
      console.log(chalk.yellow(`\n⚠  보존 대상 ${skipped.length}개 자동 제외:`));
      skipped.slice(0, 5).forEach((s) =>
        console.log(chalk.yellow(`   • ${s.subject.slice(0, 55)}  [${s.reason}]`))
      );
      if (skipped.length > 5) console.log(chalk.yellow(`   ... 외 ${skipped.length - 5}개`));
      console.log('');
    }

    if (!safeIds.length) { console.log(chalk.green('✅ 보존 대상 제외 후 삭제할 메일이 없습니다.\n')); return 0; }

    const label   = mode === 'trash' ? '휴지통으로 이동' : '영구 삭제';
    const spinner = ora(`${safeIds.length}개 메일 ${label} 중...`).start();
    try {
      const count = mode === 'trash'
        ? await client.trashMessages(safeIds)
        : await client.deleteMessages(safeIds);
      spinner.succeed(
        mode === 'trash'
          ? chalk.green(`✅ ${count}개 메일을 휴지통으로 이동했습니다.`) + chalk.gray('  (30일 내 복구 가능)')
          : chalk.green(`✅ ${count}개 메일을 영구 삭제했습니다.`)
      );
      const logLevel = mode === 'delete' ? 'warn' : 'success';
      logger[logLevel]('CLEAN', `[IMAP] ${label} 완료 — ${count}개 (보존 제외: ${skipped.length}개)`, true);
      return count;
    } catch (err) {
      logger.error('CLEAN', `[IMAP] ${label} 오류: ${err.message}`, true);
      spinner.fail(`오류 발생: ${err.message}`); throw err;
    }
  }

  return { scanAll, dryRun, execute };
}

module.exports = { createCleaner };
