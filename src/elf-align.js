import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// Checks native libraries inside a built APK/AAB for 16 KB page alignment, the same thing
// Google's check_elf_alignment.sh does: every PT_LOAD segment of every 64-bit .so must be
// aligned to at least 16 KB. Pure Node: a minimal ZIP reader plus an ELF header parser.

const PAGE_16K = 16384;
const ABIS_64 = ['arm64-v8a', 'x86_64'];

function readZipEntries(buf) {
  // End of central directory record is in the last 64 KB (+22 bytes).
  const min = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64: large APKs/AABs may need the ZIP64 end of central directory.
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const locator = eocd - 20;
    if (locator >= 0 && buf.readUInt32LE(locator) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(locator + 8));
      count = Number(buf.readBigUInt64LE(z64 + 32));
      cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // ZIP64 extra field carries the real sizes/offset when the 32-bit fields are maxed out.
    let e = p + 46 + nameLen;
    const end = e + extraLen;
    while (e + 4 <= end) {
      const id = buf.readUInt16LE(e);
      const len = buf.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (compSize === 0xffffffff) { compSize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = Number(buf.readBigUInt64LE(q)); }
      }
      e += 4 + len;
    }
    entries.push({ name, method, compSize, size, localOffset });
    p = end + commentLen;
  }
  return entries;
}

function entryData(buf, entry) {
  const p = entry.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`bad local header for ${entry.name}`);
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`unsupported compression ${entry.method} for ${entry.name}`);
}

// Smallest PT_LOAD alignment of a 64-bit little-endian ELF, or null if it is not one.
export function minLoadAlignment(elf) {
  if (elf.length < 64 || elf.readUInt32BE(0) !== 0x7f454c46) return null;
  if (elf[4] !== 2 || elf[5] !== 1) return null; // ELFCLASS64, little-endian
  const phoff = Number(elf.readBigUInt64LE(32));
  const phentsize = elf.readUInt16LE(54);
  const phnum = elf.readUInt16LE(56);
  let min = null;
  for (let i = 0; i < phnum; i++) {
    const h = phoff + i * phentsize;
    if (h + 56 > elf.length) break;
    if (elf.readUInt32LE(h) !== 1) continue; // PT_LOAD
    const align = Number(elf.readBigUInt64LE(h + 48));
    if (min === null || align < min) min = align;
  }
  return min;
}

// Returns { file, libs: [{ path, align }], misaligned: [...] } for one APK/AAB.
export function checkArchive(file) {
  const buf = fs.readFileSync(file);
  const libs = [];
  for (const entry of readZipEntries(buf)) {
    const m = entry.name.match(/(?:^|\/)lib\/([^/]+)\/[^/]+\.so$/);
    if (!m || !ABIS_64.includes(m[1])) continue;
    let align = null;
    try {
      align = minLoadAlignment(entryData(buf, entry));
    } catch {
      align = null;
    }
    if (align !== null) libs.push({ path: entry.name, align });
  }
  return { file, libs, misaligned: libs.filter((l) => l.align < PAGE_16K) };
}

// Most recently built release (preferred) or debug artifact under android/app/build/outputs.
export function findBuiltArtifact(root) {
  const base = path.join(root, 'android', 'app', 'build', 'outputs');
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let list;
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(apk|aab)$/.test(e.name)) found.push({ file: full, mtime: fs.statSync(full).mtimeMs, release: /release/i.test(full) });
    }
  };
  walk(base, 0);
  found.sort((a, b) => Number(b.release) - Number(a.release) || b.mtime - a.mtime);
  return found[0] ? found[0].file : null;
}
