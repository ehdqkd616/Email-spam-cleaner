const Table = require('cli-table3');
const chalk = require('chalk');

const PROVIDER_LABELS = {
  gmail: 'Gmail',
  naver: 'Naver Mail',
  nate:  'Nate Mail',
};

function printBanner(email, providerKey = '') {
  const service = PROVIDER_LABELS[providerKey] || '이메일';
  const title   = `${service} 광고·스팸 자동 정리 도구`;
  const pad     = Math.max(0, Math.floor((42 - title.length) / 2));
  const line    = ' '.repeat(pad) + title;

  console.log(chalk.bold.blue('\n╔══════════════════════════════════════════╗'));
  console.log(chalk.bold.blue(`║${line.padEnd(42)}║`));
  console.log(chalk.bold.blue('╚══════════════════════════════════════════╝'));
  if (email) console.log(chalk.gray(`  계정: ${email}`));
  console.log('');
}

function printQueryTable(queries) {
  const table = new Table({
    head: ['#', '카테고리', '설명'],
    style: { head: ['cyan'] },
    colWidths: [4, 22, 50],
  });

  Object.entries(queries).forEach(([, q], i) => {
    table.push([i + 1, q.name, q.description]);
  });

  console.log(table.toString());
}

function printResultTable(results) {
  const table = new Table({
    head: ['카테고리', '대상 메일 수'],
    style: { head: ['cyan'] },
    colWidths: [30, 16],
  });

  let total = 0;
  for (const result of Object.values(results)) {
    const count = result.messages?.length ?? 0;
    total += count;
    table.push([
      result.name,
      result.error ? chalk.red('오류') : chalk.yellow(String(count)),
    ]);
  }

  table.push([chalk.bold('합계'), chalk.bold.yellow(String(total))]);
  console.log(table.toString());
  return total;
}

module.exports = { printBanner, printQueryTable, printResultTable };
