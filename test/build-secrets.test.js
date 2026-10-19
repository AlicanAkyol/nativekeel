import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { secretsInBuilds } from '../src/build-secrets.js';
import { findSecrets } from '../src/secrets.js';
import { makeProject, FAKE_AWS_ID } from './helpers.js';

// A minimal ZIP (deflate) writer, enough for an APK/IPA-shaped archive.
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const comp = zlib.deflateRawSync(data);
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(local, n, comp);
    central.push(cd, n);
    offset += 30 + n.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

const HERMES_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);
const stripe = ['sk_', 'live_', '51HxQ2wE4rT6yU8iO0pA1sD3fG5hJ7kL9zX'].join('');
const openai = ['sk-', 'proj-', 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z', 'T3Blbk', 'FJ', 'AB7cDE0fGH3iJK6lmN9oPq2rSt5uVw8xYz1'].join('');

test('Hermes bytecode: keys stored back to back with other strings are found, CSS names are not', () => {
  // Hermes string storage: no separators between strings.
  const hbc = Buffer.concat([HERMES_MAGIC, Buffer.from(`stripe${stripe}openai${openai}mask-image-linear-from-colorMixWithOthersTypeNamesk-position-x-attribsPrefixfaArrowsTurnRight`, 'latin1')]);
  const rules = findSecrets(hbc.toString('latin1'), { binary: true }).map((s) => s.rule).sort();
  assert.deepEqual(rules, ['openai-key', 'stripe-secret']);
  // A key in a string with non-ASCII characters is stored as UTF-16.
  const utf16 = Buffer.concat([HERMES_MAGIC, Buffer.from(`Ödeme ${stripe}`, 'utf16le')]);
  assert.equal(findSecrets(utf16.toString('latin1').replace(/\x00/g, ''), { binary: true })[0]?.rule, 'stripe-secret');
});

test('built apps: APK found under android/app/build, IPA passed explicitly, source keys not repeated', () => {
  const root = makeProject({ 'package.json': { name: 'a', dependencies: { 'react-native': '0.87.1' } } });
  const apkDir = path.join(root, 'android/app/build/outputs/apk/release');
  fs.mkdirSync(apkDir, { recursive: true });
  fs.writeFileSync(path.join(apkDir, 'app-release.apk'), zip({ 'AndroidManifest.xml': 'x', 'assets/index.android.bundle': Buffer.concat([HERMES_MAGIC, Buffer.from(`k${stripe}x${FAKE_AWS_ID}`)]) }));
  const ipa = path.join(root, '..', `ci-${path.basename(root)}.ipa`);
  fs.writeFileSync(ipa, zip({ 'Payload/A.app/main.jsbundle': `var k="${openai}";` }));
  const r = secretsInBuilds(root, { artifacts: [ipa], known: new Set([FAKE_AWS_ID.slice(0, 16)]) });
  assert.deepEqual(r.secrets.map((s) => `${s.rule} ${s.entry}`).sort(), ['openai-key Payload/A.app/main.jsbundle', 'stripe-secret assets/index.android.bundle']);
  assert.match(r.secrets.find((s) => s.rule === 'stripe-secret').file, /^android\/app\/build\/outputs\/apk\/release\/app-release\.apk$/);
  const missing = secretsInBuilds(root, { artifacts: [path.join(root, 'nope.apk')] });
  assert.match(missing.errors[0], /not found/);
  fs.rmSync(ipa);
});
