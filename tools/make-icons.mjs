/**
 * 生成 PWA 图标（纯 Node，无第三方依赖）
 * 输出：assets/icons/icon-180.png, icon-192.png, icon-512.png, maskable-512.png
 * 运行：npm run icons
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'assets', 'icons');
fs.mkdirSync(outDir, { recursive: true });

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- 绘制 ---------- */
const smoothstep = (edge0, edge1, x) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

function renderIcon(size, { safe = 1 } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const scale = safe; // 内容缩放（maskable 留安全区）
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const nx = (u - 0.5) * 2;
      const ny = (v - 0.5) * 2;
      const d = Math.hypot(nx, ny);

      // 背景：深空蓝黑 + 中心青色辉光
      const glow = Math.pow(Math.max(0, 1 - Math.hypot(nx, ny + 0.12) / 1.25), 2.2);
      let r = 4 + glow * 9;
      let g = 6 + glow * 26;
      let b = 12 + glow * 34;

      // 细网格
      const grid = (Math.abs(((u * 24) % 1) - 0.5) > 0.485 || Math.abs(((v * 24) % 1) - 0.5) > 0.485) ? 0.045 : 0;
      r += grid * 30; g += grid * 40; b += grid * 55;

      // 外环：青色
      const ringR = 0.43 * scale;
      const ring = 1 - smoothstep(0.0, 0.022, Math.abs(d - ringR));
      r = mix(r, 55, ring); g = mix(g, 242, ring); b = mix(b, 255, ring);

      // 内环：紫色
      const ring2 = 1 - smoothstep(0.0, 0.017, Math.abs(d - 0.31 * scale));
      r = mix(r, 139, ring2); g = mix(g, 92, ring2); b = mix(b, 255, ring2);

      // 中心点
      const dot = 1 - smoothstep(0.045 * scale, 0.062 * scale, d);
      r = mix(r, 233, dot); g = mix(g, 240, dot); b = mix(b, 255, dot);

      // 中心水平细线（测光准星）
      const bar = (Math.abs(ny) < 0.006 * scale && Math.abs(nx) < 0.30 * scale) ? 1 : 0;
      r = mix(r, 55, bar); g = mix(g, 242, bar); b = mix(b, 255, bar);

      // 四分刻度
      const tick = (1 - smoothstep(0.0, 0.012 * scale, Math.abs(d - 0.50 * scale))) *
        (Math.abs(nx) > Math.abs(ny) * 1.6 || Math.abs(ny) > Math.abs(nx) * 1.6 ? 0.55 : 0);
      r = mix(r, 120, tick); g = mix(g, 190, tick); b = mix(b, 255, tick);

      const idx = (y * size + x) * 4;
      px[idx] = Math.round(Math.min(255, r));
      px[idx + 1] = Math.round(Math.min(255, g));
      px[idx + 2] = Math.round(Math.min(255, b));
      px[idx + 3] = 255;
    }
  }
  return encodePNG(size, size, px);
}

const targets = [
  ['icon-180.png', 180, 1],
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['maskable-512.png', 512, 0.78]
];

for (const [name, size, safe] of targets) {
  const png = renderIcon(size, { safe });
  fs.writeFileSync(path.join(outDir, name), png);
  console.log('✓', name, png.length + ' bytes');
}
console.log('icons written to assets/icons');