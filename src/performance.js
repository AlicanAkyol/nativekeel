import fs from './read-boundary.js';
import path from 'node:path';
import { rootImportEvidence } from './import-evidence.js';
import { gitIgnored } from './git.js';

// Performance problems you can see in the code: things that make lists stutter, animations run
// on the JavaScript thread, or the app download heavier than it needs to be. Runtime profiling
// (frame drops, start-up time) needs a device; these are the static signs.

const SKIP_DIRS = new Set(['node_modules', '.git', 'Pods', 'build', '.gradle', 'DerivedData', '.expo', 'dist', 'coverage', 'vendor', '__tests__', '__mocks__', 'e2e', 'android', 'ios']);
const JS_EXT = /\.(?:[cm]?[jt]sx?)$/;

function* walk(dir, test, ignored = gitIgnored(dir)) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && !ignored(path.join(dir, e.name))) yield* walk(path.join(dir, e.name), test, ignored);
    } else if (test.test(e.name) && !ignored(path.join(dir, e.name)) && !/\.(test|spec)[._]/.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name)) {
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

// Logging that only runs in development is left out of the count: `if (__DEV__) { … }`,
// `if (__DEV__) console.log(…)` and `__DEV__ && console.log(…)` (the same with
// process.env.NODE_ENV !== 'production'). Release builds set __DEV__ to false.
const DEV_GUARD = /\bif\s*\(\s*(?:__DEV__|process\.env\.NODE_ENV\s*!==?\s*['"]production['"])\s*\)\s*/g;
export function devOnlyRemoved(code) {
  let out = code.replace(/\b__DEV__\s*&&\s*console\./g, '__DEV__ && _dev_.');
  for (let m; (m = DEV_GUARD.exec(out)); ) {
    const start = m.index + m[0].length;
    let end;
    if (out[start] === '{') {
      let depth = 0;
      for (end = start; end < out.length; end++) {
        if (out[end] === '{') depth++;
        else if (out[end] === '}' && --depth === 0) break;
      }
    } else {
      end = out.indexOf('\n', start);
      if (end < 0) end = out.length;
    }
    out = out.slice(0, start) + out.slice(start, end + 1).replace(/console\./g, '_dev_.') + out.slice(end + 1);
  }
  return out;
}

// True when the release build strips console calls: babel-plugin-transform-remove-console, or
// Metro's minifier with drop_console (Terser) or pure_funcs listing console.log.
export function consoleRemovedInRelease(root) {
  const babel = ['babel.config.js', '.babelrc', 'babel.config.json'].map((f) => read(path.join(root, f))).join('\n');
  const metro = ['metro.config.js', 'metro.config.cjs', 'metro.config.mjs', 'metro.config.ts'].map((f) => read(path.join(root, f))).join('\n').replace(/\/\/[^\n]*/g, '');
  return /transform-remove-console|remove-console/.test(babel) || /drop_console['"]?\s*[:=]\s*(?:true|\[)/.test(metro) || /pure_funcs['"]?\s*[:=]\s*\[[^\]]*console\.log/.test(metro);
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
    logs += (devOnlyRemoved(code).match(/\bconsole\.(?:log|debug|info)\s*\(/g) || []).length;
    // Redux selectors that build a new object or array on every call ({ ... }, or `|| {}` / `|| []`
    // as a fallback) without an equality function: the component re-renders on every store update.
    for (const m of code.matchAll(/\buseSelector\s*(?:<[^>]*>)?\s*\(\s*\(?\s*\w+\s*(?::\s*[\w$.<>[\]|\s]+)?\)?\s*(?::\s*[\w$.<>[\]|\s]+)?=>\s*(\(\s*\{|[^,;\n]*\|\|\s*(?:\{\s*\}|\[\s*\]))/g)) {
      const call = code.slice(m.index, m.index + 600);
      const close = call.indexOf(')\n') >= 0 ? call.slice(0, call.indexOf(')\n') + 1) : call;
      if (/shallowEqual|isEqual|equalityFn|,\s*\w+Equal\s*\)/.test(close)) continue;
      selectors.push(`${rel}:${code.slice(0, m.index).split('\n').length}`);
    }
    for (const hit of rootImportEvidence(text)) if (!heavyImports.has(hit.name)) heavyImports.set(hit.name, `${rel}:${hit.line}`);
  }

  if (nested.length) {
    findings.push({
      id: 'perf-nested-lists',
      severity: 'medium',
      area: 'performance',
      title: `Review a list nested inside a ScrollView (${nested[0]}${nested.length > 1 ? ` and ${nested.length - 1} more` : ''})`,
      detail: 'The source contains nested list component names. Confirm these resolve to the expected React Native components and share a scroll direction. This arrangement may interfere with virtualization; mounted row counts, memory use and scrolling performance have not been measured. Consider making the list the scroll container after checking layout behavior.',
      fix: { kind: 'performance', step: `In \`${nested[0]}\`, make the FlatList the scroll container (ListHeaderComponent/ListFooterComponent) instead of nesting it in a ScrollView.` },
    });
  }
  if (jsDriver >= 3) {
    findings.push({
      id: 'perf-js-driven-animations',
      severity: 'low',
      area: 'performance',
      title: `${jsDriver} animations run on the JavaScript thread (useNativeDriver: false, e.g. ${jsDriverAt})`,
      detail: 'The source contains useNativeDriver: false settings. Confirm these configure active React Native Animated calls. JavaScript-driven animations can be affected by busy JS work, but no dropped frames were measured. Check whether each animated property supports the native driver before changing it; layout properties may require a different implementation.',
      fix: { kind: 'performance', step: 'Switch transform/opacity animations to `useNativeDriver: true` (or Reanimated for layout properties).' },
    });
  }
  if (logs >= 30 && !consoleRemovedInRelease(root)) {
    findings.push({
      id: 'perf-console-in-release',
      severity: 'low',
      area: 'performance',
      title: `Review ${logs} console logging calls in source`,
      detail: 'Logging calls were found without a recognized console-removal setting (babel-plugin-transform-remove-console, or drop_console in Metro\'s minifierConfig). Other build transforms or development guards may remove them. Inspect the release bundle and logging payloads before changing configuration; runtime cost and data exposure have not been established.',
      fix: { kind: 'performance', step: "If unnecessary logging remains in the release bundle, review production-only console removal while preserving required diagnostics and argument side effects." },
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
  // JSON imported from code: Metro puts the whole file into the JavaScript bundle as a module.
  const bigJson = [];
  const seenJson = new Set();
  for (const file of walk(root, JS_EXT)) {
    const text = read(file);
    const testOnly = /(?:^|[/\\])(?:__tests__|__mocks__|__fixtures__|fixtures|mocks?|stories|storybook|e2e|tests?)(?:[/\\]|$)|\.(?:stories|mock|fixture)\.[jt]sx?$/;
    if (testOnly.test(path.relative(root, file))) continue;
    for (const m of text.matchAll(/(?:\bfrom\s*|\brequire\(\s*|\bimport\(\s*)['"](\.{1,2}\/[^'"]+\.json)['"]/g)) {
      const json = path.resolve(path.dirname(file), m[1]);
      if (testOnly.test(path.relative(root, json))) continue;
      if (seenJson.has(json)) continue;
      seenJson.add(json);
      try {
        const size = fs.statSync(json).size;
        if (size <= 300 * 1024) continue;
        let head = '';
        const fd = fs.openSync(json, 'r');
        try { const buf = Buffer.alloc(4000); head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, 4000, 0)); } finally { fs.closeSync(fd); }
        const lottie = /"layers"\s*:/.test(head) && /"(?:ddd|fr|ip|op)"\s*:/.test(head);
        // A require() indented inside a function is still bundled, but only evaluated when that
        // code runs; a module-level import or require is evaluated when its module loads.
        const lineStart = text.lastIndexOf('\n', m.index) + 1;
        const deferred = m[0].startsWith('require') && /^[ \t]+/.test(text.slice(lineStart, m.index)) && !/^[ \t]*(?:export\s+)?(?:const|let|var)\s+[\w${}\s,]+=\s*require/.test(text.slice(lineStart, m.index + 20)) || false;
        bigJson.push({ rel: path.relative(root, json), size, lottie, lazy: m[0].startsWith('import('), deferred });
      } catch {
        // missing file
      }
    }
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
  const eager = bigJson.filter((j) => !j.lazy);
  if (eager.length) {
    eager.sort((a, b) => b.size - a.size);
    const total = eager.reduce((t, j) => t + j.size, 0);
    const deferredCount = eager.filter((j) => j.deferred).length;
    const lotties = eager.filter((j) => j.lottie);
    const LOCALE = /(?:^|[/._-])(?:ar|bg|cs|da|de|el|en|es|et|fa|fi|fr|he|hi|hr|hu|id|it|ja|ko|lt|lv|ms|nb|nl|no|pl|pt|ro|ru|sk|sl|sr|sv|th|tr|uk|vi|zh)(?:[-_][A-Za-z]{2,4})?(?=[/._-]|$)/;
    const locales = eager.filter((j) => !j.lottie && LOCALE.test(j.rel.replace(/\.json$/, '')));
    const advice = [
      ...(locales.length >= 2 ? [`${locales.length} look like translations: load only the active language (dynamic import per locale, or download them) instead of importing every language up front`] : []),
      ...(lotties.length ? [`${lotties.length} ${lotties.length === 1 ? 'is a Lottie animation' : 'are Lottie animations'}: .lottie files load as assets instead of inside the JavaScript bundle (add "lottie" to Metro's assetExts, as the lottie-react-native README shows)`] : []),
    ];
    findings.push({
      id: 'perf-large-json',
      severity: total > 5 * 1024 * 1024 ? 'medium' : 'low',
      area: 'performance',
      title: `${eager.length} JSON file${eager.length === 1 ? '' : 's'} over 300 KB imported into the JavaScript bundle (${(total / 1024 / 1024).toFixed(1)} MB)`,
      detail: `${eager.slice(0, 3).map((j) => `${j.rel} (${Math.round(j.size / 1024)} KB)`).join(', ')}${eager.length > 3 ? ', …' : ''}. A JSON file imported or required from code becomes a module in the JavaScript bundle, so every user downloads it.${deferredCount === eager.length ? ` ${eager.length === 1 ? 'It is' : 'They are'} required inside a function, so evaluated only when that code runs.` : deferredCount ? ` ${eager.length - deferredCount} ${eager.length - deferredCount === 1 ? 'is' : 'are'} imported at module level and evaluated when ${eager.length - deferredCount === 1 ? 'its' : 'their'} module loads; ${deferredCount} ${deferredCount === 1 ? 'is' : 'are'} required inside functions and evaluated only when used.` : ' Imported at module level, it is evaluated when its module loads, whether or not that screen is used.'}${advice.length ? ` ${advice.join('. ')}.` : ' Fetch data the app does not always need, or load it with a dynamic import.'} The start-up cost was not measured.`,
      evidence: eager.slice(0, 20).map((j) => ({ kind: 'source', file: j.rel, bytes: j.size, ...(j.lottie ? { lottie: true } : {}) })),
      fix: { kind: 'performance', step: `Keep large data out of the start-up bundle: ${eager.slice(0, 2).map((j) => `\`${j.rel}\``).join(', ')}${eager.length > 2 ? ` and ${eager.length - 2} more` : ''}${locales.length >= 2 ? ' (load only the active language)' : ''}${lotties.length ? ' (convert Lottie JSON to .lottie assets)' : ''}. Compare the release bundle size before and after.` },
    });
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
