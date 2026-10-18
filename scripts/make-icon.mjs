// Draws the app icon (prose lines and a block cursor) as a 1024px PNG.
// Run: node scripts/make-icon.mjs && npx tauri icon src-tauri/icons/source.png
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const N = 1024;
const px = Buffer.alloc(N * N * 4);
const set = (x, y, [r, g, b, a]) => { const i = (y * N + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a; };
const rect = (x0, y0, w, h, c) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, c); };
const inRounded = (x, y, m, r) => {
  const cx = Math.min(Math.max(x, m + r), N - m - r), cy = Math.min(Math.max(y, m + r), N - m - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (inRounded(x, y, 100, 180)) set(x, y, [36, 41, 46, 255]);
const ink = [233, 225, 206, 255];
[[620], [700], [540], [660], [380]].forEach(([w], i) => rect(212, 250 + i * 110, w, 44, ink));
rect(212 + 380 + 20, 250 + 4 * 110 - 18, 44, 80, [87, 166, 74, 255]);

const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
writeFileSync('src-tauri/icons/source.png', Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]));
