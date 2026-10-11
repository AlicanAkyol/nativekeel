import fs from './read-boundary.js';
import path from 'node:path';
import { lex } from './security-source.js';

// Performance problems you can see in the code: things that make lists stutter, animations run
// on the JavaScript thread, or the app download heavier than it needs to be. Runtime profiling
// (frame drops, start-up time) needs a device; these are the static signs.

const SKIP_DIRS = new Set(['node_modules', '.git', 'Pods', 'build', '.gradle', 'DerivedData', '.expo', 'dist', 'coverage', 'vendor', '__tests__', '__mocks__', 'e2e', 'android', 'ios']);
const JS_EXT = /\.(?:[cm]?[jt]sx?)$/;

function* walk(dir, test) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) yield* walk(path.join(dir, e.name), test);
    } else if (test.test(e.name) && !/\.(test|spec)[._]/.test(e.name)) {
      yield path.join(dir, e.name);
    }
  }
}

const read = (file) => {
  try {
    return fs.statSync(file).size > 512 * 1024 ? '' : fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

// The props text of the JSX tag starting at `start` (up to its closing `>` or `/>`, skipping
// `>` inside {...} expressions such as arrow functions).
function tagProps(text, start) {
  let depth = 0;
  for (let i = start + 1; i < text.length && i < start + 4000; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return { props: text.slice(start, i), end: i + 1 };
  }
  return { props: text.slice(start, start + 4000), end: start + 4000 };
}

// Token evidence avoids examples hidden in comments, strings and regex literals.
// This is still a source signal, not module resolution or proof of inclusion in a build.
function rootImports(text) {
  let tokens;
  try { tokens = lex(text); } catch { return []; }
  const found = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'id' || ['.', '?.'].includes(tokens[i - 1]?.value)) continue;
    let spec;
    if (t.value === 'require' && tokens[i + 1]?.value === '(' && tokens[i + 2]?.kind === 'string' && tokens[i + 3]?.value === ')') spec = tokens[i + 2];
    if (t.value === 'import') {
      if (tokens[i + 1]?.kind === 'string') spec = tokens[i + 1];
      else if (tokens[i + 1]?.value === '(' && tokens[i + 2]?.kind === 'string' && tokens[i + 3]?.value === ')') spec = tokens[i + 2];
      else if (!['type', 'typeof', '.', '('].includes(tokens[i + 1]?.value)) {
        for (let j = i + 1; j < Math.min(tokens.length, i + 100); j++) {
          if (tokens[j].value === ';') break;
          if (tokens[j].kind === 'id' && tokens[j].value === 'from' && tokens[j + 1]?.kind === 'string') { spec = tokens[j + 1]; break; }
        }
      }
    }
    if (spec && ['lodash', 'moment'].includes(spec.value)) found.push({ name: spec.value, line: t.line });
  }
  return found;
}

export function performanceChecks(project) {
  const root = project.root;
  const findings = [];
  const nested = [];
  let jsDriver = 0;
  let jsDriverAt = null;
  let logs = 0;
  const heavyImports = new Map();
  const selectors = [];
  for (const file of walk(root, JS_EXT)) {
    const text = read(file);
    if (!text) continue;
    const rel = path.relative(root, file);
    // Comments blanked with spaces, newlines kept: line numbers stay right.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, (c) => ' '.repeat(c.length));

    // A vertical FlatList/SectionList inside a vertical ScrollView renders every item at once
    // (React Native warns "VirtualizedLists should never be nested").
    // JSX tags only: not TypeScript generics like useRef<ScrollView>(null).
    for (const m of code.matchAll(/(?<![\w.$])<ScrollView\b/g)) {
      const open = tagProps(code, m.index);
      if (/\bhorizontal\b/.test(open.props)) continue;
      const close = code.indexOf('</ScrollView>', open.end);
      if (close < 0) continue;
      const body = code.slice(open.end, close);
      const im = body.match(/(?<![\w.$])<(FlatList|SectionList|FlashList)\b/);
      if (!im) continue;
      const inner = tagProps(body, im.index);
      if (!/\bhorizontal\b/.test(inner.props) && !/scrollEnabled\s*=\s*\{\s*false\s*\}/.test(inner.props)) {
        nested.push(`${rel}:${code.slice(0, m.index).split('\n').length}`);
      }
    }
    // Animations driven from JavaScript: every frame crosses to the JS thread.
    for (const m of code.matchAll(/useNativeDriver\s*:\s*false/g)) {
      jsDriver++;
      jsDriverAt = jsDriverAt || `${rel}:${code.slice(0, m.index).split('\n').length}`;
    }
    logs += (code.match(/\bconsole\.(?:log|debug|info)\s*\(/g) || []).length;
    // Redux selectors that build a new object or array on every call ({ ... }, or `|| {}` / `|| []`
    // as a fallback) without an equality function: the component re-renders on every store update.
    for (const m of code.matchAll(/\buseSelector\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*(\(\s*\{|[^,;\n]*\|\|\s*(?:\{\s*\}|\[\s*\]))/g)) {
      const call = code.slice(m.index, m.index + 600);
      const close = call.indexOf(')\n') >= 0 ? call.slice(0, call.indexOf(')\n') + 1) : call;
      if (/shallowEqual|isEqual|equalityFn|,\s*\w+Equal\s*\)/.test(close)) continue;
      selectors.push(`${rel}:${code.slice(0, m.index).split('\n').length}`);
    }
    for (const hit of rootImports(text)) if (!heavyImports.has(hit.name)) heavyImports.set(hit.name, `${rel}:${hit.line}`);
  }

  if (nested.length) {
    findings.push({
      id: 'perf-nested-lists',
      severity: 'medium',
      area: 'performance',
      title: `A list inside a ScrollView renders every item at once (${nested[0]}${nested.length > 1 ? ` and ${nested.length - 1} more` : ''})`,
      detail: 'A vertical FlatList/SectionList inside a vertical ScrollView loses virtualization: all rows mount up front, which costs memory and makes long lists stutter or crash on low-end Android. Use the list as the scroll container and move the other content into ListHeaderComponent/ListFooterComponent.',
      fix: { kind: 'performance', step: `In \`${nested[0]}\`, make the FlatList the scroll container (ListHeaderComponent/ListFooterComponent) instead of nesting it in a ScrollView.` },
    });
  }
  if (jsDriver >= 3) {
    findings.push({
      id: 'perf-js-driven-animations',
      severity: 'low',
      area: 'performance',
      title: `${jsDriver} animations run on the JavaScript thread (useNativeDriver: false, e.g. ${jsDriverAt})`,
      detail: 'Each frame of these animations waits for JavaScript, so they drop frames whenever the app is busy. Transform and opacity animations can use useNativeDriver: true; layout animations can move to Reanimated.',
      fix: { kind: 'performance', step: 'Switch transform/opacity animations to `useNativeDriver: true` (or Reanimated for layout properties).' },
    });
  }
  const babel = ['babel.config.js', '.babelrc', 'babel.config.json'].map((f) => read(path.join(root, f))).join('\n');
  if (logs >= 30 && !/transform-remove-console|remove-console/.test(babel)) {
    findings.push({
      id: 'perf-console-in-release',
      severity: 'low',
      area: 'performance',
      title: `${logs} console.log calls ship in the release build`,
      detail: 'They run in production, slow the JavaScript thread in hot paths, and can write user data to the device log. Strip them from release builds with babel-plugin-transform-remove-console (keep console.error/warn).',
      fix: { kind: 'performance', step: "Add `['transform-remove-console', { exclude: ['error', 'warn'] }]` to the production `env` of your Babel config." },
    });
  }
  if (selectors.length) {
    findings.push({
      id: 'perf-redux-selector-new-object',
      severity: 'low',
      area: 'performance',
      title: `${selectors.length} Redux selector${selectors.length === 1 ? ' returns' : 's return'} a new object on every call (${selectors[0]}${selectors.length > 1 ? ` and ${selectors.length - 1} more` : ''})`,
      detail: 'useSelector compares results by reference. A selector that builds an object, or falls back to a new {} or [], returns a different value every time, so the component re-renders on every store update anywhere in the app (react-redux warns about it in development). Select each value separately, pass shallowEqual as the second argument, or keep a constant fallback outside the component.',
      fix: { kind: 'performance', step: `In \`${selectors[0]}\`, select values separately or pass \`shallowEqual\` to useSelector, and use a constant (not a new {} or []) as the fallback.` },
    });
  }
  if (heavyImports.size) {
    const advice = { lodash: 'check whether the used methods can use same-version per-method entry points; first review chaining, mixins and bundler transforms', moment: 'review the used date, locale and timezone behavior before considering any alternative' };
    findings.push({
      id: 'perf-heavy-imports',
      severity: 'low',
      area: 'performance',
      title: `Review root imports of ${[...heavyImports.keys()].join(' and ')}`,
      detail: `${[...heavyImports].map(([k, at]) => `${k} (${at}): ${advice[k]}`).join('; ')}. Source import patterns do not establish which code ships: aliases and build transforms may change the result. Inspect the release bundle before proposing a change. No size or startup saving has been measured.`,
      fix: { kind: 'performance', step: `Review the release bundle and behavior before changing imports: ${[...heavyImports.keys()].map((k) => advice[k]).join('; ')}. Keep the current implementation if the change adds risk without a measured benefit.` },
      ...(heavyImports.has('lodash') ? { recommendation: {
        recipe: 'lodash-import-scope',
        version: 1,
        status: 'needs-verification',
        evidence: [{ kind: 'source-pattern', file: heavyImports.get('lodash'), package: 'lodash' }],
        reason: 'Per-method entry points may avoid including unrelated Lodash methods. Another consumer or a build transform may already determine the shipped code, so the source pattern alone does not establish a saving.',
        measuredBenefit: null,
        automaticFix: false,
        requirements: [
          'Confirm the source pattern is an actual runtime import and resolves to the expected Lodash 4 version (other versions are outside this recipe).',
          'Check all consumers, aliases, chaining, mixins and dynamic method access; keep the package installed.',
          'Compare the unchanged implementation with a reviewed same-version per-method import change, using identical release build settings.',
          'Run tests for the affected behavior and compare the actual bundles with nativekeel compare-imports; do not infer startup or frame-rate gains from bytes.',
        ],
        source: 'https://lodash.com/',
      } } : {}),
    });
  }

  // Oversized images bundled with the app (require()d from code): download size and decode
  // memory. Screenshots and docs in the repo are not part of the app, so only required files count.
  const big = [];
  const seen = new Set();
  for (const file of walk(root, JS_EXT)) {
    const text = read(file);
    for (const m of text.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+\.(?:png|jpe?g|gif|webp))['"]\s*\)|import\s+\w+\s+from\s+['"](\.{1,2}\/[^'"]+\.(?:png|jpe?g|gif|webp))['"]/gi)) {
      const img = path.resolve(path.dirname(file), m[1] || m[2]);
      if (seen.has(img)) continue;
      seen.add(img);
      try {
        const size = fs.statSync(img).size;
        if (size > 500 * 1024) big.push({ rel: path.relative(root, img), size });
      } catch {
        // missing or @2x variant only
      }
    }
  }
  if (big.length) {
    big.sort((a, b) => b.size - a.size);
    const total = big.reduce((s, b) => s + b.size, 0);
    findings.push({
      id: 'perf-large-images',
      severity: big.length >= 5 || total > 10 * 1024 * 1024 ? 'medium' : 'low',
      area: 'performance',
      title: `${big.length} image${big.length === 1 ? '' : 's'} over 500 KB in the app (${(total / 1024 / 1024).toFixed(1)} MB)`,
      detail: `${big.slice(0, 3).map((b) => `${b.rel} (${Math.round(b.size / 1024)} KB)`).join(', ')}${big.length > 3 ? ', …' : ''}. They grow the download and take memory when decoded. Resize to the size shown on screen (2x/3x) and use WebP.`,
      fix: { kind: 'performance', step: `Resize and convert the largest bundled images (${big.slice(0, 2).map((b) => `\`${b.rel}\``).join(', ')}) to WebP at the size shown on screen.` },
    });
  }
  return findings;
}
