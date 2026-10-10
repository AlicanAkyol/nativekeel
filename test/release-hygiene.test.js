import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every release must be visible (the owner's standing rule): README "What's new" (the npm page)
// and the top changelog entry name the version in package.json. A release cannot go out without.
const root = new URL('..', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, root), 'utf8');

test('README "What\'s new" and the changelog match the package version', () => {
  const { version } = JSON.parse(read('package.json'));
  const readme = read('README.md').match(/\*\*What's new in ([\d.]+):\*\*/);
  assert.ok(readme, 'README has a "What\'s new in X" line');
  assert.equal(readme[1], version, 'README "What\'s new" names the current version');
  const top = read('site/changelog.html').match(/<div class="rel"><h2>([\d.]+)<\/h2>/);
  assert.equal(top && top[1], version, 'the newest changelog entry is the current version');
});

test('every exported check is actually called (storeReviewRules was imported but never called from 0.1.42 to 0.1.51)', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  const all = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
  const missing = [];
  for (const f of ['security.js', 'store-rules.js', 'stability.js', 'native.js', 'performance.js', 'usage.js', 'interop.js']) {
    for (const m of all[f].matchAll(/^export (?:async )?function (\w+)/gm)) {
      const called = Object.entries(all).some(([g, text]) => {
        const body = g === f ? text.replace(new RegExp(`export (?:async )?function ${m[1]}\\b`), '') : text.replace(/^import[^;]+;/gm, '');
        return new RegExp(`\\b${m[1]}\\s*\\(`).test(body);
      });
      if (!called) missing.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('no hidden bidi or zero-width characters in our own code (Trojan Source)', () => {
  const base = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bad = [];
  for (const dir of ['bin', 'src', 'test', 'scripts']) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(m?js|json)$/.test(e.name)) {
          const text = fs.readFileSync(p, 'utf8');
          if (/[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/.test(text)) bad.push(path.relative(base, p));
        }
      }
    };
    if (fs.existsSync(path.join(base, dir))) walk(path.join(base, dir));
  }
  assert.deepEqual(bad, []);
});

test("the README What's new line keeps its fixed tail when the version changes", () => {
  const readme = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');
  const line = readme.split('\n').find((l) => l.startsWith("**What's new in "));
  assert.ok(line, "README has a What's new line");
  for (const part of ['Recent releases added', 'Every check is tuned on', '[All releases →](https://nativekeel.com/changelog)']) assert.ok(line.includes(part), `missing: ${part}`);
});

test('server.json (MCP Registry) matches package.json', () => {
  const base = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
  const server = JSON.parse(fs.readFileSync(path.join(base, 'server.json'), 'utf8'));
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].version, pkg.version);
  assert.deepEqual(server.packages[0].packageArguments, [{ type: 'positional', value: 'mcp' }]);
  assert.ok(server.description.length <= 100, 'the registry allows 100 characters');
});
