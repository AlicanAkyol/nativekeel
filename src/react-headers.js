import fs from './read-boundary.js';
import path from 'node:path';
import { findPackageDir } from './project.js';

// React Native 0.87 serves its iOS headers from header-only XCFrameworks, so a React header
// imported without its namespace is not found and the build stops. Compiled against 0.87.1 one
// header at a time: <RCTConvert.h> fails for every RCT*.h under react-native/React (I18n aside),
// with the default prebuilt core and when building from source. "RCTConvert.h" fails only with the
// prebuilt core, except the headers below. Headers under Libraries/ follow the release notes
// (<RCTAppDelegate.h> → <React/RCTAppDelegate.h>); their quoted form was not tested and is not
// reported. An import inside an `#if __has_include(...)` chain is a fallback the compiler skips.
// Only libraries (pod targets) fail: compiled in the app target of a 0.87.1 app, <RCTAppDelegate.h>,
// <RCTBridge.h> and "RCTAppDelegate.h" all resolve, so the app's own files are not reported
// (checked 2026-10-18 after Zeus and Jellify, both on 0.87.1, were wrongly flagged).
const QUOTED_OK_DIRS = new Set(['CoreModules', 'I18n', 'FBReactNativeSpec']);
const QUOTED_OK = new Set(['RCTFabricComponentsPlugins.h', 'RCTLocalizedString.h']);
const ANGLE_OK_DIRS = new Set(['I18n']);
const SKIP = /^(node_modules|android|example|examples|Example|__tests__|__mocks__|Pods|build|DerivedData|web|docs|\..*|.*\.xcframework)$/;

const read = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};

function walk(dir, depth, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (depth < 6 && !SKIP.test(e.name)) walk(path.join(dir, e.name), depth + 1, out);
    } else if (/\.(h|m|mm)$/.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

// header name -> { quoted: resolves?, angle: resolves? } for the installed react-native.
function headerTable(root) {
  const rn = findPackageDir(root, 'react-native');
  if (!rn) return null;
  const table = new Map();
  const base = path.join(rn, 'React');
  let dirs = [];
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {}
  const note = (f, quoted, angle) => {
    const name = path.basename(f);
    if (!/^RCT\w+\.h$/.test(name)) return;
    const t = table.get(name) || { quoted: false, angle: false };
    table.set(name, { quoted: t.quoted || quoted, angle: t.angle || angle });
  };
  for (const dir of dirs) {
    for (const f of walk(path.join(base, dir), 0, [])) note(f, QUOTED_OK_DIRS.has(dir) || QUOTED_OK.has(path.basename(f)), ANGLE_OK_DIRS.has(dir));
  }
  for (const f of walk(path.join(rn, 'Libraries'), 0, [])) note(f, true, false);
  return table.size ? table : null;
}

// Returns the first offending import per file: { file, line, header }.
function scanFiles(files, table, own, prebuilt) {
  const hits = [];
  for (const f of files) {
    if (!/\.(h|m|mm)$/.test(f)) continue;
    const lines = read(f).replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).split('\n');
    const stack = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const d = l.match(/^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)/);
      if (d) {
        if (d[1] === 'endif') stack.pop();
        else if (d[1] === 'elif') stack[stack.length - 1] = stack[stack.length - 1] || /__has_include/.test(d[2]);
        else if (d[1] !== 'else') stack.push(/__has_include/.test(d[2]));
        continue;
      }
      const m = l.match(/^\s*#\s*(?:import|include)\s*(["<])(RCT\w+\.h)[">]/);
      if (!m || stack.some(Boolean) || own.has(m[2])) continue;
      const t = table.get(m[2]);
      if (!t || (m[1] === '"' ? !prebuilt || t.quoted : t.angle)) continue;
      hits.push({ file: f, line: i + 1, header: `${m[1]}${m[2]}${m[1] === '"' ? '"' : '>'}` });
      break;
    }
  }
  return hits;
}

// project: loadProject() result. Libraries (direct dependencies with native iOS code) and the
// app's own ios/ folder.
// RCT_USE_PREBUILT_RNCORE=0 in the Podfile, or Expo's buildReactNativeFromSource.
function buildsFromSource(root) {
  const podfile = read(path.join(root, 'ios', 'Podfile'));
  if (/^\s*ENV\[\s*['"]RCT_USE_PREBUILT_RNCORE['"]\s*\]\s*=\s*['"]?0/m.test(podfile)) return true;
  const props = read(path.join(root, 'ios', 'Podfile.properties.json'));
  if (/"ios\.buildReactNativeFromSource"\s*:\s*"?true/.test(props)) return true;
  const config = ['app.json', 'app.config.js', 'app.config.ts'].map((f) => read(path.join(root, f))).join('\n');
  return /buildReactNativeFromSource["']?\s*:\s*true/.test(config);
}

export function unprefixedReactImports(project) {
  const root = project.root;
  const table = headerTable(root);
  const prebuilt = !buildsFromSource(root);
  const libraries = [];
  for (const name of table ? Object.keys(project.deps || {}) : []) {
    if (name === 'react-native') continue;
    const dir = findPackageDir(root, name);
    if (!dir) continue;
    const files = walk(dir, 0, []);
    if (!files.some((f) => /\.mm?$/.test(f))) continue;
    const own = new Set(files.filter((f) => f.endsWith('.h')).map((f) => path.basename(f)));
    const hits = scanFiles(files, table, own, prebuilt);
    if (hits.length) {
      let version = null;
      try {
        version = JSON.parse(read(path.join(dir, 'package.json'))).version;
      } catch {}
      libraries.push({ name, version, hits: hits.map((h) => ({ ...h, file: path.relative(dir, h.file).split(path.sep).join('/') })) });
    }
  }
  return { libraries, app: [], prebuilt };
}
