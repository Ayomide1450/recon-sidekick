// Builds the Chrome Web Store upload zip.
//
// Ships only what the extension loads at runtime: manifest.json and src/. Tests, tools,
// docs, and git metadata are excluded — reviewers see a smaller surface, and nothing
// ships that is not part of the product.
//
// Writes the ZIP with Node's zlib only, so there is no dependency to audit.

import { deflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE = ['manifest.json', 'src'];
const EXCLUDE = /(^|[/\\])(\.git|node_modules|test|tools|docs)([/\\]|$)/;

function walk(target, collected = []) {
  const absolute = join(ROOT, target);
  if (EXCLUDE.test(target)) return collected;
  if (statSync(absolute).isDirectory()) {
    for (const entry of readdirSync(absolute)) walk(join(target, entry), collected);
  } else {
    collected.push(target);
  }
  return collected;
}

// --- minimal ZIP writer -----------------------------------------------------

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

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const compressed = deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(name, 'utf8');
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(8, 8);            // method: deflate
    local.writeUInt16LE(0, 10);           // mod time
    local.writeUInt16LE(0x21, 12);        // mod date (arbitrary, deterministic)
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length
    locals.push(local, nameBuf, compressed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);     // central directory signature
    dir.writeUInt16LE(20, 4);             // version made by
    dir.writeUInt16LE(20, 6);             // version needed
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(checksum, 16);
    dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);             // extra
    dir.writeUInt16LE(0, 32);             // comment
    dir.writeUInt16LE(0, 34);             // disk number
    dir.writeUInt16LE(0, 36);             // internal attrs
    dir.writeUInt32LE(0, 38);             // external attrs
    dir.writeUInt32LE(offset, 42);        // local header offset
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

// --- build ------------------------------------------------------------------

const files = INCLUDE.flatMap((target) => walk(target));
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

const entries = files.map((file) => ({
  // ZIP entries always use forward slashes, regardless of host platform.
  name: file.split(sep).join('/'),
  data: readFileSync(join(ROOT, file)),
}));

mkdirSync(join(ROOT, 'dist'), { recursive: true });
const out = join(ROOT, 'dist', `recon-sidekick-${manifest.version}.zip`);
writeFileSync(out, zip(entries));

const totalBytes = entries.reduce((sum, e) => sum + e.data.length, 0);
console.log(`${entries.length} files, ${(totalBytes / 1024).toFixed(1)} KB uncompressed`);
for (const entry of entries) console.log('  ' + entry.name);
console.log(`\nwrote ${relative(ROOT, out)} (${(statSync(out).size / 1024).toFixed(1)} KB)`);
