require('dotenv').config();

const inquirer = require('inquirer');
const ora = require('ora');
const chalk = require('chalk');

const { printBanner } = require('./reporter');
const logger = require('./logger');

function isNaverAuthError(err) {
  const text = `${err.message || ''} ${err.responseText || ''}`.toLowerCase();
  return (
    err.authenticationFailed ||
    text.includes('authentication') ||
    text.includes('invalid credentials') ||
    text.includes('login failed') ||
    text.includes('no password') ||
    text.includes('authenticationfailed')
  );
}

// ── 프로바이더별 모듈 ────────────────────────────────────────────
const PROVIDERS = {
  gmail: {
    label: '📧  Gmail',
    async setup() {
      const { getAuthClient } = require('./gmail/auth.cli');
      const { GmailClient }   = require('./gmail/client');
      logger.info('AUTH', 'Gmail OAuth2 인증 시작', true);
      const spinner = ora('Gmail 인증 중...').start();
      const auth   = await getAuthClient();
      spinner.stop();
      return new GmailClient(auth);
    },
    queries:     () => require('./gmail/queries').QUERIES,
    cleaner:     () => require('./gmail/cleaner'),
    spammer:     () => require('./gmail/spammer'),
    filters:     () => require('./gmail/filters'),
    categorizer: () => require('./gmail/categorizer'),
  },
  cau: {
    label: '🏫  CAU 중앙대학교 (M365)',
    async setup() {
      const { getAccessToken }  = require('./cau/auth');
      const { CauGraphClient }  = require('./cau/client');
      logger.info('AUTH', 'CAU Microsoft Graph 인증 시작', true);
      const accessToken = await getAccessToken();
      const spinner = ora('CAU Microsoft Graph 연결 중...').start();
      const client = new CauGraphClient(accessToken);
      const profile = await client.getProfile();
      spinner.succeed(`CAU 메일 연결 완료  (${profile.emailAddress})`);
      logger.success('AUTH', `CAU 로그인 완료 (${profile.emailAddress})`, true);
      return client;
    },
    queries:     () => require('./cau/queries').QUERIES,
    cleaner:     () => require('./cau/cleaner'),
    spammer:     () => require('./cau/spammer'),
    filters:     null,
    categorizer: () => require('./cau/categorizer'),
  },
  nate: {
    label: '🔵  Nate Mail',
    async setup() {
      const { getNateCredentials } = require('./nate/auth');
      const { NateClient }         = require('./nate/client');
      const MAX_ATTEMPTS = 3;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const creds  = await getNateCredentials(attempt > 0);
        logger.info('AUTH', `Nate IMAP 로그인 시도 ${attempt + 1}회 (${creds.user})`, true);
        const client = new NateClient(creds);
        const spinner = ora('Nate Mail IMAP 연결 중...').start();
        try {
          await client.connect();
          spinner.succeed(`Nate Mail 연결 완료  (${creds.user})`);
          logger.success('AUTH', `Nate 로그인 완료 (${creds.user})`, true);
          return client;
        } catch (err) {
          spinner.stop();
          if (isNaverAuthError(err)) {
            const left = MAX_ATTEMPTS - attempt - 1;
            logger.warn('AUTH', `Nate 인증 실패 ${attempt + 1}회차 — 남은 시도: ${left}회`, true);
            if (left > 0) console.log(chalk.red(`  IMAP 인증 오류 — 남은 시도 횟수: ${left}회`));
            else throw new Error('Nate 로그인 3회 실패.\n아이디/비밀번호와 IMAP 활성화 여부를 확인해주세요.');
          } else {
            logger.error('AUTH', `Nate IMAP 연결 오류: ${err.message}`, true);
            throw new Error(`Nate IMAP 연결 오류: ${err.message}`);
          }
        }
      }
    },
    queries:     () => require('./nate/queries').QUERIES,
    cleaner:     () => require('./nate/cleaner'),
    spammer:     () => require('./nate/spammer'),
    filters:     null,
    categorizer: () => require('./nate/categorizer'),
    onExit:      (client) => client.disconnect(),
  },
  naver: {
    label: '🟢  Naver Mail',
    async setup() {
      const { getNaverCredentials } = require('./naver/auth');
      const { NaverClient }         = require('./naver/client');
      const MAX_ATTEMPTS = 3;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const creds  = await getNaverCredentials(attempt > 0);
        logger.info('AUTH', `Naver IMAP 로그인 시도 ${attempt + 1}회 (${creds.user})`, true);
        const client = new NaverClient(creds);
        const spinner = ora('Naver Mail IMAP 연결 중...').start();

        try {
          await client.connect();
          spinner.succeed(`Naver Mail 연결 완료  (${creds.user})`);
          logger.success('AUTH', `Naver 로그인 완료 (${creds.user})`, true);
          return client;
        } catch (err) {
          spinner.stop();

          if (isNaverAuthError(err)) {
            const left = MAX_ATTEMPTS - attempt - 1;
            logger.warn('AUTH', `Naver 인증 실패 ${attempt + 1}회차 — 남은 시도: ${left}회`, true);
            if (left > 0) {
              console.log(chalk.red(`  IMAP 인증 오류 — 남은 시도 횟수: ${left}회`));
            } else {
              throw new Error(
                'Naver 로그인 3회 실패.\n' +
                '앱 비밀번호가 맞는지 확인하거나 nid.naver.com에서 새로 발급해주세요.'
              );
            }
          } else {
            logger.error('AUTH', `Naver IMAP 연결 오류: ${err.message}`, true);
            throw new Error(`Naver IMAP 연결 오류: ${err.message}`);
          }
        }
      }
    },
    queries:     () => require('./naver/queries').NAVER_QUERIES,
    cleaner:     () => require('./naver/cleaner'),
    spammer:     () => require('./naver/spammer'),
    filters:     null,
    categorizer: () => require('./naver/categorizer'),
    onExit:      (client) => client.disconnect(),
  },
};

// ── 공통 프롬프트 헬퍼 ──────────────────────────────────────────
async function selectProvider() {
  const { key } = await inquirer.prompt([
    {
      type: 'list',
      name: 'key',
      message: '메일 서비스를 선택하세요:',
      choices: Object.entries(PROVIDERS).map(([k, p]) => ({
        name: p.label,
        value: k,
      })),
    },
  ]);
  return key;
}

async function selectReadFilter() {
  const { readFilter } = await inquirer.prompt([
    {
      type: 'list',
      name: 'readFilter',
      message: '읽음 상태를 선택하세요:',
      choices: [
        { name: '미열람 메일만  (읽지 않은 메일)', value: 'is:unread' },
        { name: '열람한 메일만  (이미 읽은 메일)', value: 'is:read'   },
        { name: '전체  (미열람 + 열람 모두)',       value: ''          },
      ],
    },
  ]);
  return readFilter;
}

async function selectCategories(queries) {
  const choices = Object.entries(queries).map(([key, q]) => ({
    name: `${q.name}  — ${q.description}`,
    value: key,
    checked: q.safe,
  }));

  const { keys } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'keys',
      message: '정리할 메일 카테고리를 선택하세요:',
      choices,
      validate: (ans) => (ans.length > 0 ? true : '최소 1개 이상 선택해주세요.'),
    },
  ]);

  return keys;
}

async function confirmTrash() {
  const { ok } = await inquirer.prompt([{
    type: 'confirm', name: 'ok',
    message: chalk.yellow('선택한 메일을 휴지통으로 이동하시겠습니까? (30일 내 복구 가능)'),
    default: false,
  }]);
  return ok;
}

async function confirmDelete() {
  const { step1 } = await inquirer.prompt([{
    type: 'confirm', name: 'step1',
    message: chalk.red('⚠  영구 삭제는 복구가 불가능합니다. 계속하시겠습니까?'),
    default: false,
  }]);
  if (!step1) return false;

  const { word } = await inquirer.prompt([{
    type: 'input', name: 'word',
    message: chalk.red('확인을 위해 "영구삭제" 를 입력하세요:'),
  }]);
  return word.trim() === '영구삭제';
}

// ── 메인 루프 ───────────────────────────────────────────────────
async function main() {
  let client;
  let providerKey;

  try {
    providerKey = await selectProvider();
    const provider = PROVIDERS[providerKey];

    client = await provider.setup();
    const profile = await client.getProfile();
    logger.success('AUTH', `[${providerKey}] 세션 시작 (${profile.emailAddress})`, true);
    printBanner(profile.emailAddress, providerKey);

    const queries      = provider.queries();
    const cleaner      = provider.cleaner();
    const spammer      = provider.spammer();
    const hasFilters   = !!provider.filters;
    const categorizer  = provider.categorizer();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const menuChoices = [
        new inquirer.Separator('── 분류 ──────────────────────'),
        { name: '📂  자동 분류  (보안·결제·배송·계정 → 카테고리 폴더)', value: 'categorize' },
        ...(providerKey === 'naver'
          ? [{ name: '🔄  이전 폴더 정리  (잘못 생성된 폴더 자동 복구 후 재분류)', value: 'cleanup' }]
          : []),
        new inquirer.Separator('── 광고 정리 ─────────────────'),
        { name: '📋  미리보기  (삭제 없이 대상 메일 확인)', value: 'dryRun' },
        { name: '🗑️   휴지통으로 이동  (30일 내 복구 가능)', value: 'trash' },
        { name: '⚠️   영구 삭제  (복구 불가)',               value: 'delete' },
        new inquirer.Separator('── 스팸 차단 ─────────────────'),
        { name: '🚫  스팸으로 표시  (스팸함으로 이동)',       value: 'spam' },
        { name: '🔒  발신자 차단',                           value: 'blockSenders' },
      ];

      if (hasFilters) {
        menuChoices.push(
          new inquirer.Separator('── 설정 ──────────────────────'),
          { name: '⚙️   자동 필터 설정  (재발 방지)', value: 'filters' }
        );
      }

      menuChoices.push(new inquirer.Separator(), { name: '🚪  종료', value: 'exit' });

      const { action } = await inquirer.prompt([{
        type: 'list', name: 'action',
        message: '작업을 선택하세요:', choices: menuChoices,
      }]);

      if (action === 'exit') { console.log(chalk.gray('\n종료합니다.\n')); logger.info('SYSTEM', `[${providerKey}] 세션 종료`, true); break; }

      if (action === 'categorize') {
        logger.info('CATEGORIZE', `[${providerKey}] 자동 분류 시작`, true);
        await categorizer.categorize(client);
        continue;
      }

      if (action === 'cleanup') {
        logger.info('CATEGORIZE', `[${providerKey}] 이전 폴더 정리 시작`, true);
        const cleaned = await categorizer.cleanupOldFolders(client);
        if (cleaned) {
          const { rerun } = await inquirer.prompt([{
            type: 'confirm',
            name: 'rerun',
            message: '지금 바로 자동 분류를 실행하시겠습니까?',
            default: true,
          }]);
          if (rerun) { logger.info('CATEGORIZE', `[${providerKey}] 재분류 실행`, true); await categorizer.categorize(client); }
        }
        continue;
      }

      if (action === 'filters' && hasFilters) {
        logger.info('FILTER', `[${providerKey}] 자동 필터 설정 시작`, true);
        await provider.filters().setupFilters(client);
        continue;
      }

      const readFilter   = await selectReadFilter();
      const selectedKeys = await selectCategories(queries);

      if (action === 'dryRun') {
        logger.info('SCAN', `[${providerKey}] 미리보기 스캔 시작 — 카테고리: ${selectedKeys.join(', ')}`, true);
        await cleaner.dryRun(client, selectedKeys, readFilter);

      } else if (action === 'trash') {
        if (await confirmTrash()) {
          logger.info('CLEAN', `[${providerKey}] 휴지통 이동 실행`, true);
          await cleaner.execute(client, selectedKeys, 'trash', readFilter);
        } else { console.log(chalk.gray('취소되었습니다.\n')); logger.info('CLEAN', `[${providerKey}] 휴지통 이동 취소`, true); }

      } else if (action === 'delete') {
        if (await confirmDelete()) {
          logger.warn('CLEAN', `[${providerKey}] 영구 삭제 실행`, true);
          await cleaner.execute(client, selectedKeys, 'delete', readFilter);
        } else { console.log(chalk.gray('취소되었습니다.\n')); logger.info('CLEAN', `[${providerKey}] 영구 삭제 취소`, true); }

      } else if (action === 'spam') {
        const { ok } = await inquirer.prompt([{
          type: 'confirm', name: 'ok',
          message: chalk.yellow('선택한 메일을 스팸으로 표시하시겠습니까?'),
          default: false,
        }]);
        if (ok) { logger.info('SPAM', `[${providerKey}] 스팸 처리 실행`, true); await spammer.markSpam(client, selectedKeys, readFilter); }
        else { console.log(chalk.gray('취소되었습니다.\n')); }

      } else if (action === 'blockSenders') {
        logger.info('BLOCK', `[${providerKey}] 발신자 차단 시작`, true);
        await spammer.blockSenders(client, selectedKeys, readFilter);
      }

      const { again } = await inquirer.prompt([{
        type: 'confirm', name: 'again',
        message: '계속 작업하시겠습니까?', default: true,
      }]);
      if (!again) break;
    }

  } catch (err) {
    logger.error('SYSTEM', `[${providerKey || 'CLI'}] 오류: ${err.message}`, true);
    console.error(chalk.red(`\n오류: ${err.message}\n`));
    process.exit(1);
  } finally {
    // Naver IMAP 연결 정리
    const onExit = PROVIDERS[providerKey]?.onExit;
    if (onExit && client) await onExit(client).catch(() => {});
  }
}

main();
