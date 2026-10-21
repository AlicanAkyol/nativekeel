import fs from './read-boundary.js';
import path from 'node:path';
import { gitIgnored } from './git.js';

// Leftovers that make a codebase harder to work in without changing what ships: backup copies of
// files, debugger statements, source files nothing imports and images nothing references. Listed
// for review under "cleanup"; they do not change the A–E ratings.

const SKIP = new Set(['node_modules', '.git', 'android', 'ios', 'build', 'dist', '.expo', 'coverage', 'vendor', 'Pods', 'web-build', '.next', '.turbo', 'storybook-static']);
const NOT_APP = /^(?:server|backend|functions|api|scripts?|cli|tools|bin|docs?|website|e2e|test|tests|__tests__|__mocks__|supabase|patches)\/|(?:^|\/)(?:__tests__|__mocks__|__fixtures__|fixtures|tests?|stories|storybook|\.storybook)\//;
const CODE = /\.[cm]?[jt]sx?$/;
const IMAGE = /\.(?:png|jpe?g|gif|webp|svg|mp4|mp3|wav|lottie)$/i;
// Names only an editor or a person making a quick copy produces: "App copy.tsx", "App (2).tsx",
// "Screen_old.js", "x.tsx.bak", a merge's ".orig". Words such as "backup" are real feature names.
const BACKUP = /(?: copy(?: \d+)?| - Copy|[ _.-](?:old|bak|orig)\d*| ?\(\d+\))\.[cm]?[jt]sx?$|\.(?:bak|orig|old)$/i;

function walk(root) {
  const out = [];
  const ignored = gitIgnored(root);
  const go = (dir, depth) => {
    if (depth > 12 || out.length > 20000) return;
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const full = path.join(dir, e.name);
      if (e.name.startsWith('.') || ignored(full)) continue;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) go(full, depth + 1); }
      else if (e.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  go(root, 0);
  return out;
}

const read = (root, rel) => { try { const f = path.join(root, rel); return fs.statSync(f).size > 1024 * 1024 ? '' : fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');

// Import specifiers of a file: import/export from, require(), import().
function specifiers(code) {
  const out = [];
  for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bexport\s*\*\s*from\s*)['"]([^'"\n]+)['"]/g)) out.push(m[1]);
  return out;
}

// Path aliases from tsconfig/jsconfig "paths" and babel-plugin-module-resolver ("alias", "root").
function aliases(root) {
  const map = [];
  const roots = [];
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const text = read(root, name);
    if (!text) continue;
    try {
      const json = JSON.parse(text.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, '$1').replace(/,\s*([}\]])/g, '$1'));
      const base = (json.compilerOptions && json.compilerOptions.baseUrl) || '.';
      for (const [k, v] of Object.entries((json.compilerOptions && json.compilerOptions.paths) || {})) {
        const target = Array.isArray(v) ? v[0] : v;
        if (typeof target === 'string') map.push([k.replace(/\*$/, ''), path.posix.join(base, target.replace(/\*$/, ''))]);
      }
      if (json.compilerOptions && json.compilerOptions.baseUrl) roots.push(json.compilerOptions.baseUrl);
    } catch { return null; }
  }
  const babel = read(root, 'babel.config.js') || read(root, '.babelrc');
  if (/module-resolver/.test(babel)) {
    const alias = babel.match(/["']?alias["']?\s*:\s*\{([\s\S]*?)\}/);
    if (alias) for (const m of alias[1].matchAll(/['"]?([@~\w/.-]+)['"]?\s*:\s*['"]([^'"]+)['"]/g)) map.push([m[1].endsWith('/') ? m[1] : `${m[1]}/`, m[2].replace(/^\.\//, '') + '/'], [m[1], m[2].replace(/^\.\//, '')]);
    const r = babel.match(/["']?root["']?\s*:\s*\[([^\]]*)\]/);
    if (r) for (const m of r[1].matchAll(/['"]([^'"]+)['"]/g)) roots.push(m[1]);
    if (/["']?alias["']?\s*:\s*\{/.test(babel) && !alias) return null;
  }
  // babel-plugin-root-import: "~/x" → "<rootPathSuffix>/x" (prefix "~" unless set).
  if (/root-import/.test(babel)) {
    const suffix = (babel.match(/rootPathSuffix['"]?\s*:\s*['"]\.?\/?([^'"]*)['"]/) || [])[1];
    const prefix = (babel.match(/rootPathPrefix['"]?\s*:\s*['"]([^'"]+)['"]/) || [])[1] || '~';
    if (suffix === undefined) return null;
    map.push([`${prefix.replace(/\/$/, '')}/`, suffix ? `${suffix.replace(/\/$/, '')}/` : '']);
  }
  return { map, roots: roots.map((x) => x.replace(/^\.\/?/, '')) };
}

const EXTS = ['', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.json'];
// Node built-ins scripts import without a node: prefix.
const NODE_BUILTINS = new Set(['assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dns', 'events', 'fs', 'http', 'http2', 'https', 'net', 'os', 'path', 'perf_hooks', 'process', 'querystring', 'readline', 'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib']);
const PLATFORMS = ['', '.native', '.ios', '.android', '.web', '.windows', '.macos', '.visionos'];

function resolver(files) {
  const set = new Set(files);
  return (base) => {
    const found = [];
    for (const p of PLATFORMS) for (const e of EXTS) {
      for (const cand of [`${base}${p}${e}`, `${base}/index${p}${e}`]) {
        const n = path.posix.normalize(cand);
        // No added extension only when the import already names one (`./Screen.js`).
        if ((e || EXTS.includes(path.posix.extname(n))) && set.has(n)) found.push(n);
      }
    }
    return found;
  };
}

// Files the app never imports, from the last hygiene run on this project (only when the import
// graph could be trusted). Other checks use it to say a finding sits in dead code.
const deadCache = new WeakMap();
export function deadFiles(project) {
  return deadCache.get(project) || null;
}

export function hygieneChecks(project) {
  const root = project.root;
  const everything = walk(root);
  const all = everything.filter((f) => !NOT_APP.test(f));
  const findings = [];

  // 1. Backup copies.
  const backups = all.filter((f) => BACKUP.test(path.posix.basename(f)));
  if (backups.length) findings.push({
    id: 'cleanup-backup-files',
    severity: 'low',
    area: 'cleanup',
    title: `${backups.length} backup cop${backups.length === 1 ? 'y' : 'ies'} of source files (${backups[0]}${backups.length > 1 ? ', …' : ''})`,
    detail: `${backups.slice(0, 8).join(', ')}${backups.length > 8 ? `, and ${backups.length - 8} more` : ''}. Old copies kept next to the real file get searched, edited and imported by mistake, and still go through type checks and linting. Git keeps the history: delete them.`,
    fix: { kind: 'cleanup', step: `Delete the backup copies (${backups.slice(0, 3).join(', ')}); git history keeps the old versions.` },
    evidence: backups.slice(0, 20).map((f) => ({ file: f, line: 1, role: 'backup' })),
  });

  const code = all.filter((f) => CODE.test(f) && !/\.d\.ts$|\.config\.[cm]?[jt]s$|(?:^|\/)(?:babel|metro|jest|eslint|prettier|tailwind|webpack|vite|react-native)\.config/.test(f) && !/\.(?:test|spec|stories|mock)\.[cm]?[jt]sx?$/.test(f));
  const texts = new Map(code.map((f) => [f, strip(read(root, f))]));

  // 2. debugger statements.
  const debuggers = [];
  for (const [f, t] of texts) {
    const m = t.match(/^[ \t]*debugger\s*;?[ \t]*$/m);
    if (m) debuggers.push(`${f}:${t.slice(0, m.index).split('\n').length}`);
  }
  if (debuggers.length) findings.push({
    id: 'cleanup-debugger',
    severity: 'low',
    area: 'cleanup',
    title: `${debuggers.length} debugger statement${debuggers.length === 1 ? '' : 's'} left in the code (${debuggers[0]}${debuggers.length > 1 ? ', …' : ''})`,
    detail: `${debuggers.slice(0, 8).join(', ')}. With a debugger attached the app stops there every time; leftovers from a debugging session. Remove them (ESLint's no-debugger catches new ones).`,
    fix: { kind: 'cleanup', step: `Remove the debugger statements (${debuggers.slice(0, 3).join(', ')}) and enable ESLint's no-debugger rule.` },
  });

  // 3. Source files nothing imports. Needs every import to resolve: if an alias or root cannot be
  // read, or some project imports stay unresolved, the check is skipped instead of guessing.
  const al = project.isLibrary ? null : aliases(root);
  if (al) {
    const resolve = resolver(code);
    let pkg = {};
    try { pkg = JSON.parse(read(root, 'package.json')) || {}; } catch {}
    const entries = new Set();
    const addEntry = (spec) => { for (const r of resolve(spec.replace(/^\.\//, ''))) entries.add(r); };
    addEntry((pkg.main && !/^expo-router\/entry|^expo\/AppEntry/.test(pkg.main)) ? pkg.main.replace(/\.[cm]?[jt]sx?$/, '') : 'index');
    // src/index is the web entry of react-native-web and Create React App setups.
    for (const e of ['App', 'src/App', 'src/index', 'app/_layout', 'src/app/_layout']) addEntry(e);
    // Config plugins and other files the Expo config points at ("./plugins/withX").
    const config = read(root, 'app.json') + read(root, 'app.config.js') + read(root, 'app.config.ts');
    for (const m of config.matchAll(/['"]\.\/([^'"]+)['"]/g)) addEntry(m[1].replace(/\.[cm]?[jt]sx?$/, ''));
    // Files package.json scripts run by path (`electron public/electron.js`, `node tools/x.mjs`).
    const scripts = JSON.stringify(pkg.scripts || {});
    // Their own imports (express, child_process) are not app imports the graph failed to follow.
    const tooling = new Set();
    for (const f of code) if (scripts.includes(f)) { entries.add(f); tooling.add(f); }
    // Node scripts run by hand (a shebang, or Node built-ins with no React Native or Expo import),
    // and Flow library definitions named in .flowconfig, are not app code that lost its import.
    const flow = read(root, '.flowconfig');
    // A file named with its extension in a string is read some other way (fs.readFileSync, a
    // preval or WebView script): `'sso.js'`.
    const quoted = new Set([...[...texts.values()].join('\n').matchAll(/['"`]([^'"`\n]*?\.[cm]?[jt]sx?)['"`]/g)].map((m) => path.posix.basename(m[1])));
    for (const f of code) if (quoted.has(path.posix.basename(f))) entries.add(f);
    for (const f of code) {
      if (flow.includes(f)) { entries.add(f); continue; }
      const t = texts.get(f) || '';
      if ((/^#!/.test(t) || /(?:from\s*|require\(\s*)['"](?:node:\w+|fs|child_process|path|os)['"]/.test(t)) && !/(?:from\s*|require\(\s*)['"](?:react-native|expo)/.test(t)) { entries.add(f); tooling.add(f); }
    }
    // A folder with its own package.json (or a HarmonyOS oh-package.json5) is another project.
    const projects = everything.filter((f) => /(?:^|\/)(?:package\.json|oh-package\.json5)$/.test(f) && f.includes('/')).map((f) => `${path.posix.dirname(f)}/`);
    for (const f of code) if (projects.some((d) => f.startsWith(d))) { entries.add(f); tooling.add(f); }
    // Codegen specs are read by the native build (package.json codegenConfig.jsSrcsDir), and a
    // Next.js app (next.config next to it) routes every file under pages/ or app/.
    const specs = pkg.codegenConfig && pkg.codegenConfig.jsSrcsDir && `${pkg.codegenConfig.jsSrcsDir.replace(/^\.\/|\/$/g, '')}/`;
    const next = everything.filter((f) => /(?:^|\/)next\.config\.[cm]?[jt]s$/.test(f)).map((f) => { const d = path.posix.dirname(f); return d === '.' ? '' : `${d}/`; });
    for (const f of code) {
      if (specs && f.startsWith(specs)) entries.add(f);
      if (next.some((d) => f.startsWith(d) && /^(?:src\/)?(?:pages|app)\//.test(f.slice(d.length)))) { entries.add(f); tooling.add(f); }
    }
    // A web service worker is built as its own entry and loaded by URL, never imported.
    for (const f of code) if (/(?:^|\/)(?:service-?worker|sw)\.[cm]?[jt]s$/i.test(f)) entries.add(f);
    // expo-router: every file under app/ is a route.
    for (const f of code) if (/^(?:src\/)?app\//.test(f) && /expo-router/.test(JSON.stringify(pkg.dependencies || {}))) entries.add(f);
    // Tests, server functions, scripts and stories count as users too: a file only they import is
    // not dead, just not in the app.
    for (const f of everything) if (CODE.test(f) && (NOT_APP.test(f) || /\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(f))) { entries.add(f); if (!texts.has(f)) texts.set(f, strip(read(root, f))); }
    // Files loaded by a computed path cannot be followed. require.context('./screens', …) loads a
    // whole folder: every file in it counts as used. Any other import()/require() of a variable or
    // template string leaves the graph incomplete: then nothing is called unused.
    let dynamic = false;
    for (const [f, t] of texts) {
      for (const m of t.matchAll(/\brequire\.context\s*\(\s*['"]([^'"]+)['"]/g)) {
        const dir = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
        for (const c of code) if (c === dir || c.startsWith(`${dir}/`)) entries.add(c);
      }
      // Only app code makes the graph incomplete: a build script or test loading by path does not.
      // Quoted strings emptied first: code written inside a string (`"require(\"ws\")"`) loads nothing.
      if (NOT_APP.test(f) || /\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(f)) continue;
      const bare = t.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, (q) => q[0] + q[0]);
      if (/\brequire\.context\s*\(\s*[^'"\s]/.test(bare) || /\b(?:import|require)\s*\(\s*(?![\s'"]|`[^`$]*`)[^)]/.test(bare)) dynamic = true;
    }
    const reached = new Set();
    const stack = [...entries];
    const unresolvedSpecs = new Set();
    const known = new Set(Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) }));
    while (stack.length) {
      const f = stack.pop();
      if (reached.has(f)) continue;
      reached.add(f);
      for (const spec of specifiers(texts.get(f) || '')) {
        let targets = [];
        if (spec.startsWith('.')) targets = resolve(path.posix.join(path.posix.dirname(f), spec));
        else {
          const a = al.map.find(([k]) => spec === k.replace(/\/$/, '') || spec.startsWith(k));
          if (a) targets = resolve(path.posix.join(a[1], spec.slice(a[0].length)));
          if (!targets.length) for (const r of al.roots) { targets = resolve(path.posix.join(r, spec)); if (targets.length) break; }
          const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
          // A bare path that is no installed package ("components/Header", "@/lib/x") is a root or
          // alias this check could not read: then the import graph cannot be trusted.
          const implicit = NODE_BUILTINS.has(pkgName) || /^(?:node:|react-native\/|@react-native\/|@expo\/|expo-|react-dom|@babel\/runtime|workbox-)/.test(spec) || ['react', 'react-native', 'expo', 'fs', 'path', 'url', 'crypto', 'buffer', 'events', 'util', 'stream'].includes(pkgName);
          if (!targets.length && !known.has(pkgName) && !implicit && !tooling.has(f)) unresolvedSpecs.add(spec);
        }
        for (const t of targets) if (!reached.has(t)) stack.push(t);
      }
    }
    const appCode = code.filter((f) => !/\.web\.[cm]?[jt]sx?$/.test(f));
    // Only folders the app itself uses: a sibling folder of scripts, tutorials or a second project
    // is not dead app code. Root-level files are left alone for the same reason.
    const appDirs = new Set([...reached].filter((f) => f.includes('/')).map((f) => f.split('/')[0]));
    // Expo local modules and workspace packages are imported by package name; command-line tools and
    // example templates are not app code.
    const orphans = appCode.filter((f) => !reached.has(f) && f.includes('/') && appDirs.has(f.split('/')[0]) && !/^(?:modules|packages|libs?)\/|(?:^|\/)(?:cli|scripts?|bin|tools)\//.test(f) && !/\.(?:example|sample|template)\.[cm]?[jt]sx?$/.test(f) && !/(?:^|\/)index\.[cm]?[jt]sx?$/.test(f));
    // Trust the graph only when it reached a real part of the app and nearly everything resolved.
    // An unresolved import that looks like an alias or a source folder ("~/x", "@/x", "#x",
    // "components/x" with a components folder) means part of the graph is missing: no report.
    const dirs = new Set(everything.filter((f) => f.includes('/')).flatMap((f) => [f.split('/')[0], f.startsWith('src/') ? f.split('/')[1] : null]).filter(Boolean));
    const aliasLike = [...unresolvedSpecs].some((sp) => /^[~#]|^@\//.test(sp) || dirs.has(sp.split('/')[0]));
    const trusted = entries.size && reached.size >= 5 && !aliasLike && !dynamic && unresolvedSpecs.size <= 2 && orphans.length < appCode.length / 2;
    if (trusted) deadCache.set(project, new Set(orphans));
    if (trusted && orphans.length) {
      findings.push({
        id: 'cleanup-unused-files',
        severity: 'low',
        area: 'cleanup',
        title: `${orphans.length} source file${orphans.length === 1 ? '' : 's'} that nothing imports (${orphans[0]}${orphans.length > 1 ? ', …' : ''})`,
        detail: `${orphans.slice(0, 10).join(', ')}${orphans.length > 10 ? `, and ${orphans.length - 10} more` : ''}. Followed every import from the app's entry point${entries.size > 1 ? 's' : ''}; no import NativeKeel could follow reaches these files. Dead files still cost type-check and review time and get copied from by mistake. Check that nothing loads them another way (a script, a test helper, native code) before deleting them.`,
        fix: { kind: 'cleanup', step: `Delete source files nothing imports (${orphans.slice(0, 3).join(', ')}${orphans.length > 3 ? ', …' : ''}) after checking they are not used outside the app.` },
        evidence: orphans.slice(0, 20).map((f) => ({ file: f, line: 1, role: 'unused' })),
      });
    }
  }

  // 4. Images nothing references. React Native loads bundled images only through a literal
  // require/import, so a file name that appears in no source or config file is not in the app.
  const images = all.filter((f) => IMAGE.test(f) && !/(?:^|\/)(?:public|static|web|docs?|screenshots?|\.github|fastlane|store|metadata)\//i.test(f) && !/^(?:readme|screenshot)/i.test(path.posix.basename(f)));
  if (images.length) {
    const haystack = [...texts.values(), ...all.filter((f) => /\.(?:json|plist|xml|html|css|md)$/.test(f) || /app\.config|eas\.json/.test(f)).map((f) => read(root, f))].join('\n');
    const unused = images.filter((f) => {
      const base = path.posix.basename(f).replace(/@\d(?:\.\d)?x(?=\.)/, '');
      return !haystack.includes(base) && !haystack.includes(base.replace(/\.[^.]+$/, ''));
    });
    const bytes = unused.reduce((s, f) => { try { return s + fs.statSync(path.join(root, f)).size; } catch { return s; } }, 0);
    if (unused.length) findings.push({
      id: 'cleanup-unused-images',
      severity: 'low',
      area: 'cleanup',
      title: `${unused.length} image or media file${unused.length === 1 ? '' : 's'} nothing references (${Math.round(bytes / 1024)} KB)`,
      detail: `${unused.slice(0, 8).join(', ')}${unused.length > 8 ? `, and ${unused.length - 8} more` : ''}. React Native bundles an image only when code requires it by its literal path, and these names appear in no source or config file, so they are not in the app; they only weigh down the repository. Check for a use outside the app (store listing, website), then delete them.`,
      fix: { kind: 'cleanup', step: `Delete images nothing references (${unused.slice(0, 3).join(', ')}${unused.length > 3 ? ', …' : ''}).` },
      evidence: unused.slice(0, 20).map((f) => ({ file: f, line: 1, role: 'unused' })),
    });
  }
  return findings;
}
