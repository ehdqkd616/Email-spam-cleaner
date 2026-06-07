const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');
const http = require('http');
const url  = require('url');

const TOKEN_PATH       = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
];

async function getAuthClient() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      'credentials.json 파일이 없습니다.\n\n' +
      '설정 방법:\n' +
      '  1. https://console.cloud.google.com 접속\n' +
      '  2. 프로젝트 생성 → Gmail API 활성화\n' +
      '  3. 사용자 인증 정보 → OAuth 2.0 클라이언트 ID 생성 (데스크톱 앱)\n' +
      '  4. JSON 다운로드 → credentials.json으로 저장 (프로젝트 루트)\n'
    );
  }

  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const { client_id, client_secret } = raw.installed || raw.web;

  const oAuth2Client = new google.auth.OAuth2(
    client_id, client_secret, 'http://localhost:3000/oauth2callback'
  );

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    oAuth2Client.setCredentials(token);
    if (token.expiry_date && token.expiry_date < Date.now()) {
      const { credentials } = await oAuth2Client.refreshAccessToken();
      oAuth2Client.setCredentials(credentials);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials, null, 2));
    }
    return oAuth2Client;
  }

  return getNewToken(oAuth2Client);
}

function getNewToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  console.log('\n인증이 필요합니다. 아래 URL을 브라우저에서 열어주세요:\n');
  console.log(authUrl);
  console.log('\n브라우저에서 인증을 완료하면 자동으로 진행됩니다...\n');

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url, true);
      if (parsed.pathname !== '/oauth2callback') return;
      const code = parsed.query.code;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>인증 완료! 이 창을 닫고 터미널로 돌아가세요.</h2>');
      server.close();
      try {
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        console.log('✅ 인증 완료! token.json이 저장되었습니다.\n');
        resolve(oAuth2Client);
      } catch (err) { reject(err); }
    });
    server.on('error', reject);
    server.listen(3000);
  });
}

module.exports = { getAuthClient };
