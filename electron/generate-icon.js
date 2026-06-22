'use strict';
// electron/generate-icon.js — icon.png + icon.ico 생성 (외부 의존성 없음)
// 실행: node electron/generate-icon.js

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── CRC-32 ─────────────────────────────────────────────────────────────
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[i] = c;
}
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG 쓰기 ────────────────────────────────────────────────────────────
function toPNG(width, height, rgba) {
  function chunk(type, data) {
    const t = Buffer.from(type, 'ascii');
    const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, d])));
    return Buffer.concat([l, t, d, c]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = y * (1 + width * 4) + 1 + x * 4;
      raw[d] = rgba[s]; raw[d+1] = rgba[s+1]; raw[d+2] = rgba[s+2]; raw[d+3] = rgba[s+3];
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// ── BMP ICO 엔트리 ──────────────────────────────────────────────────────
function toBmpIcoEntry(size, rgba) {
  const bih = Buffer.alloc(40);
  bih.writeInt32LE(40, 0); bih.writeInt32LE(size, 4); bih.writeInt32LE(size * 2, 8);
  bih.writeUInt16LE(1, 12); bih.writeUInt16LE(32, 14);

  const pix = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = ((size - 1 - y) * size + x) * 4; // BMP는 아래→위
      const d = (y * size + x) * 4;
      pix[d] = rgba[s+2]; pix[d+1] = rgba[s+1]; pix[d+2] = rgba[s]; pix[d+3] = rgba[s+3]; // BGRA
    }
  }
  const andRowBytes = Math.ceil(size / 32) * 4;
  const andMask = Buffer.alloc(andRowBytes * size, 0);
  return Buffer.concat([bih, pix, andMask]);
}

// ── ICO 파일 쓰기 (16×16 + 32×32 + 256×256) ────────────────────────────
function toICO(sizes, rgbaMap) {
  // sizes: [{ size, data }]  data = BMP entry buffer or PNG buffer
  const entries = sizes.map(({ size, pngData, bmpData }) => ({
    size,
    data: pngData || bmpData,
    isPng: !!pngData,
  }));

  const HEADER_SIZE = 6;
  const DIR_ENTRY   = 16;
  let offset = HEADER_SIZE + entries.length * DIR_ENTRY;

  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);

  const dirs = [];
  for (const e of entries) {
    const d = Buffer.alloc(DIR_ENTRY);
    d[0] = e.size >= 256 ? 0 : e.size;
    d[1] = e.size >= 256 ? 0 : e.size;
    d[2] = 0; d[3] = 0;
    d.writeUInt16LE(e.isPng ? 0 : 1, 4);
    d.writeUInt16LE(e.isPng ? 0 : 32, 6);
    d.writeUInt32LE(e.data.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.data.length;
    dirs.push(d);
  }
  return Buffer.concat([header, ...dirs, ...entries.map(e => e.data)]);
}

// ── 픽셀 캔버스 ─────────────────────────────────────────────────────────
function makeCanvas(size) {
  const buf = new Uint8Array(size * size * 4);

  function blend(x, y, r, g, b, a) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const i = (y * size + x) * 4;
    const al = a / 255, inv = 1 - al;
    buf[i]   = Math.round(buf[i]   * inv + r * al);
    buf[i+1] = Math.round(buf[i+1] * inv + g * al);
    buf[i+2] = Math.round(buf[i+2] * inv + b * al);
    buf[i+3] = Math.min(255, buf[i+3] + a);
  }

  function fillCircle(cx, cy, rad, r, g, b) {
    for (let y = Math.floor(cy - rad - 1); y <= Math.ceil(cy + rad + 1); y++)
      for (let x = Math.floor(cx - rad - 1); x <= Math.ceil(cx + rad + 1); x++) {
        const a = Math.max(0, Math.min(255, (rad - Math.hypot(x - cx, y - cy) + 0.5) * 255));
        if (a > 0) blend(x, y, r, g, b, a);
      }
  }

  function fillRoundRect(x1, y1, x2, y2, cr, r, g, b) {
    for (let y = Math.floor(y1); y <= Math.ceil(y2); y++) {
      for (let x = Math.floor(x1); x <= Math.ceil(x2); x++) {
        const nL = x < x1 + cr, nR = x > x2 - cr;
        const nT = y < y1 + cr, nB = y > y2 - cr;
        let a = 255;
        if (x < x1 || x > x2 || y < y1 || y > y2) continue;
        if ((nL || nR) && (nT || nB)) {
          const cX = nL ? x1 + cr : x2 - cr;
          const cY = nT ? y1 + cr : y2 - cr;
          a = Math.max(0, Math.min(255, (cr - Math.hypot(x - cX, y - cY) + 0.5) * 255));
        }
        if (a > 0) blend(x, y, r, g, b, a);
      }
    }
  }

  function strokeLine(x0, y0, x1, y1, thick, r, g, b) {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    const steps = Math.ceil(len * 2);
    for (let i = 0; i <= steps; i++)
      fillCircle(x0 + dx * i/steps, y0 + dy * i/steps, thick / 2, r, g, b);
  }

  return { buf, fillRoundRect, fillCircle, strokeLine };
}

// ── 아이콘 그리기 ─────────────────────────────────────────────────────
function drawIcon(S) {
  const { buf, fillRoundRect, strokeLine } = makeCanvas(S);
  const P  = S * 0.07;
  const CR = S * 0.20;

  // 배경 (인디고)
  fillRoundRect(P, P, S - P, S - P, CR, 99, 102, 241);

  // 봉투 몸통
  const EL = S * 0.17, ER = S * 0.83;
  const ET = S * 0.28, EB = S * 0.72;
  const ECR = (ER - EL) * 0.06;
  fillRoundRect(EL, ET, ER, EB, ECR, 255, 255, 255);

  // 봉투 상단 V자 접힘선 (인디고)
  const MX = (EL + ER) / 2;
  const FD = (EB - ET) * 0.44;
  const LW = Math.max(1, S * 0.022);
  strokeLine(EL, ET, MX, ET + FD, LW, 99, 102, 241);
  strokeLine(MX, ET + FD, ER, ET, LW, 99, 102, 241);

  // 봉투 하단 V자 (연한 인디고)
  const LW2 = Math.max(1, S * 0.013);
  strokeLine(EL, EB, MX, EB - FD * 0.55, LW2, 180, 182, 245);
  strokeLine(MX, EB - FD * 0.55, ER, EB, LW2, 180, 182, 245);

  return buf;
}

// ── 생성 ──────────────────────────────────────────────────────────────
const DIR = __dirname;

// 256×256 PNG
const px256 = drawIcon(256);
const png256 = toPNG(256, 256, px256);
fs.writeFileSync(path.join(DIR, 'icon.png'), png256);
console.log('✅ icon.png (256×256) 생성');

// 32×32 + 16×16 비트맵 엔트리
const px32  = drawIcon(32);
const px16  = drawIcon(16);

// ICO (16 + 32 + 256)
const ico = toICO([
  { size: 16,  bmpData: toBmpIcoEntry(16,  px16)  },
  { size: 32,  bmpData: toBmpIcoEntry(32,  px32)  },
  { size: 256, pngData: png256 },
]);
fs.writeFileSync(path.join(DIR, 'icon.ico'), ico);
console.log('✅ icon.ico (16/32/256) 생성');
