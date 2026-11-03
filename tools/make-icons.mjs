// Generates the extension icons as PNGs with no external dependencies.
//
// The mark: a dark rounded square with an amber bracket pair and a gap in the middle —
// a bracket around something missing, which is the whole idea of the tool.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');

const BG = [14, 17, 22, 255];
const AMBER = [217, 128, 20, 255];
const DIM = [92, 102, 112, 255];

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with a filter-type byte (0 = none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixels[y][x];
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function draw(size) {
  const pixels = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => [0, 0, 0, 0]),
  );

  const radius = Math.max(2, Math.round(size * 0.18));
  const inside = (x, y) => {
    // Rounded-rectangle test against the four corner circles.
    const nx = Math.min(x, size - 1 - x);
    const ny = Math.min(y, size - 1 - y);
    if (nx >= radius || ny >= radius) return true;
    const dx = radius - nx;
    const dy = radius - ny;
    return dx * dx + dy * dy <= radius * radius;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inside(x, y)) pixels[y][x] = [...BG];
    }
  }

  // Bracket geometry, proportional so it holds at 16px.
  const thickness = Math.max(1, Math.round(size * 0.09));
  const top = Math.round(size * 0.26);
  const bottom = size - 1 - top;
  const armLength = Math.max(2, Math.round(size * 0.16));
  const leftX = Math.round(size * 0.22);
  const rightX = size - 1 - leftX;

  const fill = (x0, y0, x1, y1, colour) => {
    for (let y = Math.max(0, y0); y <= Math.min(size - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(size - 1, x1); x++) {
        if (inside(x, y)) pixels[y][x] = [...colour];
      }
    }
  };

  // Left bracket: vertical spine plus top and bottom arms.
  fill(leftX, top, leftX + thickness - 1, bottom, AMBER);
  fill(leftX, top, leftX + armLength, top + thickness - 1, AMBER);
  fill(leftX, bottom - thickness + 1, leftX + armLength, bottom, AMBER);

  // Right bracket, mirrored.
  fill(rightX - thickness + 1, top, rightX, bottom, AMBER);
  fill(rightX - armLength, top, rightX, top + thickness - 1, AMBER);
  fill(rightX - armLength, bottom - thickness + 1, rightX, bottom, AMBER);

  // The gap in the middle: a dim dash standing for the surface you have not reached.
  const midY = Math.round(size / 2) - Math.floor(thickness / 2);
  const dashInset = Math.round(size * 0.37);
  if (size >= 32) {
    fill(dashInset, midY, size - 1 - dashInset, midY + thickness - 1, DIM);
  }

  return pixels;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, draw(size)));
  console.log(`wrote ${file}`);
}
