/**
 * 나이브 베이즈 텍스트 분류기 — 계정에 이미 분류된 폴더를 정답 데이터로 학습
 *
 * 하드코딩 키워드 목록은 이 계정 발신자들이 실제로 쓰는 문구를 다 못 따라간다.
 * 대신 이 계정의 진짜 정답지(Nate/Naver가 자체 분류한 "광고함" vs 이 앱의 자동분류가
 * 만든 "결제·영수증"/"금융·은행" 등 카테고리 폴더)에서 단어 통계를 학습해 확률로 판단한다.
 * (Paul Graham의 "A Plan for Spam" 이후 SpamAssassin/Bogofilter 등이 쓰는 고전적 접근)
 *
 * 완성형 한글은 형태소 분석 없이 음절 바이그램으로 토큰화한다 — 한국어는 공백 기준
 * 단어 분리가 불안정하기 때문에, 한/중/일 스팸 필터에서 흔히 쓰는 n-gram 방식을 따른다.
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HANGUL_RE = /[가-힣]+/g;
const WORD_RE   = /[a-z0-9]+/g;

// 판단에 도움이 안 되는 흔한 조사/서술어 바이그램 — 노이즈 줄이기용 최소 불용어
const STOPWORDS = new Set(['입니다', '습니다', '하세요', '됩니다', '있습', '했습']);

function tokenize(text) {
  const s = (text || '').toLowerCase();
  const tokens = [];

  for (const run of s.match(HANGUL_RE) || []) {
    if (run.length === 1) { tokens.push(run); continue; }
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2);
      if (!STOPWORDS.has(bg)) tokens.push(bg);
    }
  }
  for (const w of s.match(WORD_RE) || []) {
    if (w.length >= 2) tokens.push(w);
  }
  return tokens;
}

function train(adTexts, hamTexts) {
  const adFreq  = Object.create(null);
  const hamFreq = Object.create(null);
  let adTotal = 0, hamTotal = 0;

  for (const t of adTexts) {
    for (const tok of tokenize(t)) { adFreq[tok] = (adFreq[tok] || 0) + 1; adTotal++; }
  }
  for (const t of hamTexts) {
    for (const tok of tokenize(t)) { hamFreq[tok] = (hamFreq[tok] || 0) + 1; hamTotal++; }
  }

  const vocab = new Set([...Object.keys(adFreq), ...Object.keys(hamFreq)]);

  return {
    adFreq, hamFreq, adTotal, hamTotal,
    vocabSize: vocab.size,
    adDocs: adTexts.length,
    hamDocs: hamTexts.length,
    trainedAt: new Date().toISOString(),
  };
}

// 학습 데이터가 최소치를 못 채우면 신뢰할 수 없는 모델 — 호출 측에서 사용하지 않아야 함
function isModelUsable(model) {
  return !!model && model.adDocs >= 20 && model.hamDocs >= 20;
}

/**
 * @param {object} model
 * @param {string} text
 * @param {number} threshold  이 확률 이상일 때만 광고로 판정 (기본 0.9 — 오탐 방지를 위해 보수적으로)
 */
function classify(model, text, threshold = 0.9) {
  if (!isModelUsable(model)) return { isAd: false, probability: 0 };

  const { adFreq, hamFreq, adTotal, hamTotal, vocabSize, adDocs, hamDocs } = model;
  const alpha = 1;
  let logAd  = Math.log(adDocs  / (adDocs + hamDocs));
  let logHam = Math.log(hamDocs / (adDocs + hamDocs));

  for (const tok of tokenize(text)) {
    const adCount  = adFreq[tok]  || 0;
    const hamCount = hamFreq[tok] || 0;
    logAd  += Math.log((adCount  + alpha) / (adTotal  + alpha * vocabSize));
    logHam += Math.log((hamCount + alpha) / (hamTotal + alpha * vocabSize));
  }

  const probabilityAd = 1 / (1 + Math.exp(logHam - logAd));
  return { isAd: probabilityAd >= threshold, probability: probabilityAd };
}

// ── 계정 폴더에서 학습 데이터 수집 (IMAP 전용: Nate/Naver) ──────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function trainFromImapClient(client, { adFolders = [], hamFolders = [] } = {}) {
  // 폴더를 연달아 SELECT하면 Nate가 BYE로 끊는 경우가 있어 폴더 사이 짧게 텀을 둔다
  const adTexts = [];
  for (const folder of adFolders) {
    adTexts.push(...await client.fetchTrainingTexts(folder));
    await sleep(300);
  }
  const hamTexts = [];
  for (const folder of hamFolders) {
    hamTexts.push(...await client.fetchTrainingTexts(folder));
    await sleep(300);
  }
  return train(adTexts, hamTexts);
}

// ── 모델 캐시 (계정 폴더를 매번 다시 읽으면 스캔이 느려짐) ──────────

function modelPath(provider) {
  return path.join(DATA_DIR, `bayes-${provider}.json`);
}

function saveModel(provider, model) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(modelPath(provider), JSON.stringify(model), 'utf8');
}

function loadModel(provider) {
  try { return JSON.parse(fs.readFileSync(modelPath(provider), 'utf8')); }
  catch (_) { return null; }
}

function isStale(model, maxAgeMs = 24 * 60 * 60 * 1000) {
  if (!model || !model.trainedAt) return true;
  return Date.now() - new Date(model.trainedAt).getTime() > maxAgeMs;
}

/**
 * 캐시된 모델을 쓰거나, 없거나 오래됐으면 계정 폴더에서 새로 학습
 * 학습 데이터가 부족하면 null 반환 (호출 측은 규칙 기반 판정만 사용)
 */
async function getOrTrainModel(provider, client, trainConfig) {
  let model = loadModel(provider);
  if (isModelUsable(model) && !isStale(model)) return model;

  try {
    model = await trainFromImapClient(client, trainConfig);
  } catch (_) {
    return isModelUsable(model) ? model : null; // 학습 실패 시 이전 캐시라도 유지
  }

  if (isModelUsable(model)) {
    saveModel(provider, model);
    return model;
  }
  return null;
}

module.exports = {
  tokenize, train, classify, isModelUsable,
  trainFromImapClient, getOrTrainModel,
  loadModel, saveModel, isStale,
};
