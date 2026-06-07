const { PublicClientApplication } = require('@azure/msal-node');
const fs    = require('fs');
const path  = require('path');
const chalk = require('chalk');

const CLIENT_ID = '66413960-b249-4d69-8d55-17104a75e496';
const TENANT_ID = 'd5561224-c59d-4e1c-8dac-26e2ff4feb85';
const SCOPES    = ['https://graph.microsoft.com/Mail.ReadWrite'];
const CACHE_PATH = path.join(
  process.env.USERPROFILE || process.env.HOME || '.',
  '.mailcleaner_cau_token.json'
);

async function getAccessToken() {
  const pca = new PublicClientApplication({
    auth: {
      clientId: CLIENT_ID,
      authority: `https://login.microsoftonline.com/${TENANT_ID}`,
    },
  });

  // 캐시된 토큰으로 조용히 인증 시도
  if (fs.existsSync(CACHE_PATH)) {
    try {
      pca.getTokenCache().deserialize(fs.readFileSync(CACHE_PATH, 'utf8'));
      const accounts = await pca.getTokenCache().getAllAccounts();
      if (accounts.length) {
        const result = await pca.acquireTokenSilent({ scopes: SCOPES, account: accounts[0] });
        if (result) {
          fs.writeFileSync(CACHE_PATH, pca.getTokenCache().serialize());
          return result.accessToken;
        }
      }
    } catch (_) { /* 캐시 만료 시 기기 코드 플로우로 진행 */ }
  }

  // 기기 코드 플로우 — 브라우저에서 CAU 계정으로 인증
  const result = await pca.acquireTokenByDeviceCode({
    scopes: SCOPES,
    deviceCodeCallback: ({ verificationUri, userCode }) => {
      console.log(chalk.bold.cyan('\n🔐 CAU Microsoft 계정 인증'));
      console.log(chalk.white('  1. 브라우저에서 아래 주소 접속:'));
      console.log(chalk.bold.yellow(`     ${verificationUri}`));
      console.log(chalk.white('  2. 아래 코드 입력:'));
      console.log(chalk.bold.yellow(`     ${userCode}\n`));
    },
  });

  fs.writeFileSync(CACHE_PATH, pca.getTokenCache().serialize());
  return result.accessToken;
}

module.exports = { getAccessToken };
