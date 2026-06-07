const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const logger  = require('../../logger');

// ── 세션 헬퍼 ──────────────────────────────────────────────────────
function setProvider(req, key, data) {
  if (!req.session.providers) req.session.providers = {};
  req.session.providers[key] = data;
}
function getProvider(req, key) {
  return req.session.providers?.[key] || null;
}

// ── GET /api/auth/status ───────────────────────────────────────────
// 연결된 모든 프로바이더 상태 반환
router.get('/status', (req, res) => {
  const providers = req.session.providers || {};
  res.json({
    gmail: providers.gmail ? { connected: true, email: providers.gmail.email } : { connected: false },
    naver: providers.naver ? { connected: true, email: providers.naver.email } : { connected: false },
    nate:  providers.nate  ? { connected: true, email: providers.nate.email  } : { connected: false },
    cau:   providers.cau   ? { connected: true, email: providers.cau.email   } : { connected: false },
  });
});

// ── Gmail ─────────────────────────────────────────────────────────

router.get('/gmail', (req, res) => {
  try {
    const { getAuthUrl } = require('../../gmail/auth.web');
    res.json({ authUrl: getAuthUrl() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/gmail/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'code 없음' });
  logger.info('AUTH', 'Gmail OAuth2 콜백 수신');
  try {
    const { handleCallback } = require('../../gmail/auth.web');
    const { GmailClient }    = require('../../gmail/client');
    const auth = await handleCallback(code);
    const client = new GmailClient(auth);
    const profile = await client.getProfile();
    setProvider(req, 'gmail', { email: profile.emailAddress });
    logger.success('AUTH', `Gmail 로그인 완료 (${profile.emailAddress})`);
    const redirectUrl = `${process.env.CLIENT_URL || 'http://localhost:5173'}?provider=gmail&status=success`;
    res.redirect(redirectUrl);
  } catch (err) {
    logger.error('AUTH', `Gmail 로그인 실패: ${err.message}`);
    const redirectUrl = `${process.env.CLIENT_URL || 'http://localhost:5173'}?provider=gmail&status=error&msg=${encodeURIComponent(err.message)}`;
    res.redirect(redirectUrl);
  }
});

// ── IMAP (Naver / Nate) ───────────────────────────────────────────

router.post('/imap', async (req, res) => {
  const { provider, user, password } = req.body;
  if (!provider || !user || !password)
    return res.status(400).json({ error: '필드 누락' });

  const label = provider === 'naver' ? 'Naver' : 'Nate';
  logger.info('AUTH', `${label} IMAP 로그인 시도 (${user})`);

  try {
    let client;
    if (provider === 'naver') {
      const { NaverClient } = require('../../naver/client');
      client = new NaverClient({ user, password });
    } else if (provider === 'nate') {
      const { NateClient } = require('../../nate/client');
      client = new NateClient({ user, password });
    } else {
      return res.status(400).json({ error: '지원하지 않는 프로바이더' });
    }

    await client.connect();
    const profile = await client.getProfile();
    await client.disconnect();

    setProvider(req, provider, { email: profile.emailAddress, user, password });
    logger.success('AUTH', `${label} 로그인 완료 (${profile.emailAddress})`);
    res.json({ success: true, email: profile.emailAddress });
  } catch (err) {
    logger.error('AUTH', `${label} 로그인 실패 (${user}): ${err.message}`);
    res.status(401).json({ error: err.message });
  }
});

// ── CAU (Microsoft Graph OAuth2 기기 코드 플로우) ─────────────────

router.get('/cau/start', async (req, res) => {
  logger.info('AUTH', 'CAU Microsoft 기기 코드 인증 시작');
  try {
    const { PublicClientApplication } = require('@azure/msal-node');
    const CLIENT_ID = '66413960-b249-4d69-8d55-17104a75e496';
    const TENANT_ID = 'd5561224-c59d-4e1c-8dac-26e2ff4feb85';

    const pca = new PublicClientApplication({
      auth: { clientId: CLIENT_ID, authority: `https://login.microsoftonline.com/${TENANT_ID}` },
    });

    // 기기 코드 요청
    let deviceCodeInfo = null;
    const tokenPromise = pca.acquireTokenByDeviceCode({
      scopes: ['https://graph.microsoft.com/Mail.ReadWrite'],
      deviceCodeCallback: (info) => { deviceCodeInfo = info; },
    });

    // 기기 코드가 생성될 때까지 대기
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (deviceCodeInfo) { clearInterval(check); resolve(); }
      }, 100);
    });

    // 토큰 취득 작업을 세션에 저장 (백그라운드 진행)
    req.session.cauTokenPromise = tokenPromise.then(async (result) => {
      const { CauGraphClient } = require('../../cau/client');
      const client = new CauGraphClient(result.accessToken);
      const profile = await client.getProfile();
      setProvider(req, 'cau', { email: profile.emailAddress, accessToken: result.accessToken });
      logger.success('AUTH', `CAU 로그인 완료 (${profile.emailAddress})`);
      return profile.emailAddress;
    }).catch((err) => {
      logger.error('AUTH', `CAU 로그인 실패: ${err.message}`);
      throw err;
    });

    res.json({
      verificationUri: deviceCodeInfo.verificationUri,
      userCode: deviceCodeInfo.userCode,
      expiresIn: deviceCodeInfo.expiresIn,
      message: deviceCodeInfo.message,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/cau/poll', async (req, res) => {
  const provider = getProvider(req, 'cau');
  if (provider) return res.json({ status: 'done', email: provider.email });

  // tokenPromise 결과 확인
  if (req.session.cauTokenPromise) {
    try {
      // 이미 완료됐으면 즉시 반환, 아니면 pending
      const raceResult = await Promise.race([
        req.session.cauTokenPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('pending')), 100)),
      ]);
      return res.json({ status: 'done', email: raceResult });
    } catch (err) {
      if (err.message === 'pending') return res.json({ status: 'pending' });
      return res.status(401).json({ status: 'error', error: err.message });
    }
  }

  res.json({ status: 'pending' });
});

// ── 연결 해제 ──────────────────────────────────────────────────────

router.delete('/:provider', (req, res) => {
  const { provider } = req.params;
  if (req.session.providers) delete req.session.providers[provider];
  logger.info('AUTH', `${provider} 연결 해제`);
  res.json({ success: true });
});

module.exports = router;
