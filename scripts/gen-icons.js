// Dependency-free PNG icon generator: draws a gold poker chip on felt green.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(OUT, { recursive: true });

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawChip(size) {
  const px = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const R = size * 0.42;
  const felt = [11, 61, 46], gold = [240, 180, 41], goldDark = [199, 143, 20], cream = [250, 243, 220];
  const put = (i, [r, g, b]) => { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      put(i, felt);
      const dx = x - cx, dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (d > R) continue;
      const angle = ((Math.atan2(dy, dx) / Math.PI) * 180 + 360) % 360;
      const stripe = Math.floor(angle / 30) % 2 === 0; // 12 edge stripes
      if (d > R * 0.82) put(i, stripe ? cream : gold);
      else if (d > R * 0.78) put(i, goldDark);
      else if (d > R * 0.45) put(i, gold);
      else if (d > R * 0.42) put(i, goldDark);
      else put(i, cream);
      // "C" letterform in the center
      const cR = R * 0.28;
      if (d < cR && d > cR * 0.55) {
        const a = ((Math.atan2(dy, dx) / Math.PI) * 180 + 360) % 360;
        if (!(a > 315 || a < 45)) put(i, goldDark); // gap on the right = C
      }
    }
  }
  return px;
}

for (const size of [192, 512]) {
  writeFileSync(join(OUT, `icon-${size}.png`), encodePNG(size, drawChip(size)));
  console.log(`icon-${size}.png written`);
}
