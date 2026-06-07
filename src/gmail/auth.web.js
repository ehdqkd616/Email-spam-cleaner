// Gmail OAuth2 어댑터 — Express 웹 서버용
//
// CLI(auth.cli.js)와 다른 점:
//   CLI  → 임시 HTTP 서버를 직접 열어 콜백을 받음
//   웹   → Express 라우터가 /oauth2callback 경로를 처리하고
//           이 모듈의 handleCallback()을 호출해 토큰을 저장
//
// 사용 예시 (server/routes/auth.js):
//   const { getAuthUrl, handleCallback, getAuthClient } = require('../../src/gmail/auth.web');
//   router.get('/auth',           (req, res) => res.redirect(getAuthUrl()));
//   router.get('/oauth2callback', async (req, res) => {
//     await handleCallback(req.query.code);
//     res.redirect('/');
//   });

const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const TOKEN_PATH       = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
const REDIRECT_URI     = `http://localhost:${process.env.PORT || 3001}/api/auth/gmail/callback`;

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
];

function createOAuthClient() {
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const { client_id, client_secret } = raw.installed || raw.web;
  return new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);
}

function getAuthUrl() {
  return createOAuthClient().generateAuthUrl({ access_type: 'offline', scope: SCOPES });
}

async function handleCallback(code) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  return client;
}

async function getAuthClient() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  const client = createOAuthClient();
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
  client.setCredentials(token);
  if (token.expiry_date && token.expiry_date < Date.now()) {
    const { credentials } = await client.refreshAccessToken();
    client.setCredentials(credentials);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials, null, 2));
  }
  return client;
}

function requireAuth(req, res, next) {
  if (!fs.existsSync(TOKEN_PATH)) return res.redirect('/auth');
  next();
}

module.exports = { getAuthUrl, handleCallback, getAuthClient, requireAuth };
