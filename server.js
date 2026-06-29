require('dotenv').config();

const express    = require('express');
const session    = require('express-session');
const cors       = require('cors');
const path       = require('path');

const authRouter = require('./src/api/routes/auth');
const mailRouter = require('./src/api/routes/mail');
const logsRouter = require('./src/api/routes/logs');

const app  = express();
const PORT = process.env.PORT || 3005;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5174';
const IS_PROD = process.env.NODE_ENV === 'production';

// ── 미들웨어 ───────────────────────────────────────────────────────
app.use(express.json());
app.use(cors({
  origin: IS_PROD ? false : CLIENT_URL,
  credentials: true,
}));
app.use(session({
  secret: process.env.SESSION_SECRET || 'mailcleaner-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: IS_PROD,
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24, // 24시간
  },
}));

// ── API 라우트 ─────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/mail', mailRouter);
app.use('/api/logs', logsRouter);

// ── 프로덕션: React 빌드 서빙 ──────────────────────────────────────
if (IS_PROD) {
  app.use(express.static(path.join(__dirname, 'client', 'dist')));
  app.use((_, res) =>
    res.sendFile(path.join(__dirname, 'client', 'dist', 'index.html'))
  );
}

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  if (!IS_PROD) console.log(`프론트엔드: ${CLIENT_URL}`);
});
