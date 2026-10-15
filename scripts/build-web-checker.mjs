#!/usr/bin/env node
// Builds site/check/checker.js: the scanner bundled for the browser (nativekeel.com/check).
// Build-time only; nothing here ships in the npm package. Run: node scripts/build-web-checker.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const deps = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-web-'));
try {
  execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--ignore-scripts', '--prefix', deps, 'esbuild@0.25.10', 'path-browserify@1.0.1'], { stdio: 'inherit' });
  // esbuild's binary comes from an optional platform package; --ignore-scripts skips nothing it needs.
  const require = createRequire(path.join(deps, 'package.json'));
  const esbuild = require('esbuild');
  const stub = path.join(repo, 'web/stubs/node.js');
  const pathBrowserify = require.resolve('path-browserify');
  const browser = {
    name: 'nativekeel-browser',
    setup(build) {
      // The scanner reads files only through read-boundary.js; in the browser that is the pasted project.
      build.onResolve({ filter: /\/read-boundary\.js$/ }, () => ({ path: path.join(repo, 'web/vfs.js') }));
      build.onResolve({ filter: /^(node:)?path$/ }, () => ({ path: pathBrowserify }));
      build.onResolve({ filter: /^path-browserify$/ }, () => ({ path: pathBrowserify }));
      build.onResolve({ filter: /^node:/ }, () => ({ path: stub }));
    },
  };
  const result = await esbuild.build({
    entryPoints: [path.join(repo, 'web/checker-entry.js')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    outfile: path.join(repo, 'site/check/checker.js'),
    banner: { js: 'globalThis.process=globalThis.process||{env:{},cwd:()=>"/",platform:"browser"};' },
    plugins: [browser],
    metafile: true,
    logLevel: 'warning',
  });
  const bytes = fs.statSync(path.join(repo, 'site/check/checker.js')).size;
  console.log(`wrote site/check/checker.js (${Math.round(bytes / 1024)} KB, ${Object.keys(result.metafile.inputs).length} inputs)`);
} finally {
  fs.rmSync(deps, { recursive: true, force: true });
}
