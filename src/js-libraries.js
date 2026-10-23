import fs from './read-boundary.js';
import path from 'node:path';
import { findPackageDir, cleanVersion } from './project.js';
import { lockedVersions } from './lockfile.js';
import { compareVersions } from './known-issues.js';

// JavaScript libraries that still call an API React Native removed. The app's own code can be clean
// and the app still crash (InteractionManager, the StatusBar setters) or lose a layout silently
// (StyleSheet.absoluteFillObject) on upgrade, because a dependency calls it. Native libraries are
// covered by the header check; these are the JavaScript ones.
//
// With node_modules the installed code is read. Without it, KNOWN lists releases verified by hand
// against their published code (scripts/lab/js-lib-removed-api.mjs on the npm tarballs).

// change id (upcoming.js) -> how a library really uses the removed API, and what in the same file
// means it is not React Native's (its own copy) or is guarded (checked before it is called).
const USES = {
  'rn87-interaction-manager': {
    use: /\bInteractionManager\s*\.\s*(?:runAfterInteractions|createInteractionHandle|clearInteractionHandle|setDeadline)\s*\(/,
    own: /\bInteractionManager\s*=\s*\{|\b(?:const|let|var|function|class)\s+InteractionManager\b/,
    guard: /typeof\s+InteractionManager\b|\bInteractionManager\s*(?:&&|\?(?!\.))|\bInteractionManager\s*\?\./,
  },
  'rn87-statusbar-props': {
    use: /\bStatusBar\s*\.\s*(?:setBackgroundColor|setTranslucent|setNetworkActivityIndicatorVisible)\s*\(/,
    own: /\bStatusBar\s*=\s*\{|\bclass\s+StatusBar\b/,
    guard: /\bStatusBar\s*\.\s*(?:setBackgroundColor|setTranslucent|setNetworkActivityIndicatorVisible)\b(?!\s*\()|StatusBar\s*\?\.\s*set/,
  },
  'rn85-absolute-fill-object': {
    use: /\bStyleSheet\s*\.\s*absoluteFillObject\b(?!\s*=[^=])/,
    own: /\babsoluteFillObject\s*=\s*\{/,
    guard: /\bStyleSheet\s*\.\s*absoluteFillObject\s*(?:\?\?|\|\|)|StyleSheet\s*\?\.\s*absoluteFillObject/,
  },
};

// Releases checked (24 Oct 2026) on their published code with this file's own rules
// (scripts/lab/verify-js-libs.mjs), from the oldest release found to have it to the newest. Older majors can differ (native-base 2.x and draggable-flatlist before
// 4.0.3 do not use these APIs) and a later release may fix it, so only that range is matched.
export const KNOWN = [
  // StyleSheet.absoluteFillObject (0.85): the named components lose their layout.
  { name: 'react-native-elements', change: 'rn85-absolute-fill-object', from: '3.0.0', upTo: '3.4.3', where: 'SpeedDial and others' },
  { name: '@rneui/base', change: 'rn85-absolute-fill-object', from: '4.0.0', upTo: '5.0.0', where: 'Image' },
  { name: 'react-native-calendars', change: 'rn85-absolute-fill-object', from: '1.1275.0', upTo: '1.1314.0', where: 'Timeline' },
  { name: 'react-native-snap-carousel', change: 'rn85-absolute-fill-object', from: '3.0.0', upTo: '3.9.1', where: 'ParallaxImage' },
  { name: 'moti', change: 'rn85-absolute-fill-object', from: '0.25.4', upTo: '0.30.0', where: 'Skeleton' },
  { name: 'native-base', change: 'rn85-absolute-fill-object', from: '3.0.0', upTo: '3.4.28', where: 'AspectRatio' },
  { name: 'react-native-flash-message', change: 'rn85-absolute-fill-object', from: '0.4.0', upTo: '0.4.2', where: 'FlashMessage' },
  { name: 'react-native-image-viewing', change: 'rn85-absolute-fill-object', from: '0.2.0', upTo: '0.2.2', where: 'Modal (Android)' },
  { name: 'react-native-circular-progress-indicator', change: 'rn85-absolute-fill-object', from: '4.0.0', upTo: '4.4.2', where: 'CircularProgress' },
  { name: 'react-native-skeleton-placeholder', change: 'rn85-absolute-fill-object', from: '5.0.0', upTo: '5.2.4', where: 'SkeletonPlaceholder' },
  { name: 'react-native-indicators', change: 'rn85-absolute-fill-object', from: '0.17.0', upTo: '0.17.0', where: 'BallIndicator' },
  { name: '@ui-kitten/components', change: 'rn85-absolute-fill-object', from: '4.4.1', upTo: '6.2.1', where: 'TopNavigation, CircularProgressBar' },
  { name: 'react-native-ui-lib', change: 'rn85-absolute-fill-object', from: '9.0.0', upTo: '9.1.3', where: 'HighlighterOverlayView' },
  { name: 'react-native-material-dropdown', change: 'rn85-absolute-fill-object', from: '0.11.0', upTo: '0.11.1', where: 'Dropdown' },
  { name: '@howljs/calendar-kit', change: 'rn85-absolute-fill-object', from: '2.0.0', upTo: '2.5.6', where: 'MultiDayBarItem' },
  { name: 'react-native-video-player', change: 'rn85-absolute-fill-object', from: '0.16.0', upTo: '0.16.3', where: 'Video' },
  { name: 'react-native-shared-element', change: 'rn85-absolute-fill-object', from: '0.8.0', upTo: '0.8.9', where: 'SharedElementTransition' },
  { name: 'react-navigation-drawer', change: 'rn85-absolute-fill-object', from: '2.0.0', upTo: '2.7.2', where: 'Drawer' },
  // InteractionManager (0.87): a crash when that code runs.
  { name: 'react-native-modal', change: 'rn87-interaction-manager', from: '11.10.0', upTo: '14.0.0', where: 'Modal' },
  { name: 'react-native-draggable-flatlist', change: 'rn87-interaction-manager', from: '4.0.3', upTo: '4.0.3', where: 'DraggableFlatList' },
  { name: 'react-navigation-stack', change: 'rn87-interaction-manager', from: '2.0.0', upTo: '2.10.4', where: 'Stack Card' },
  { name: 'react-native-svg-charts', change: 'rn87-interaction-manager', from: '5.3.0', upTo: '5.4.0', where: 'animated paths' },
  { name: 'react-native-safe-area-view', change: 'rn87-interaction-manager', from: '1.0.0', upTo: '1.1.1', where: 'SafeAreaView' },
  { name: 'react-navigation-shared-element', change: 'rn87-interaction-manager', from: '3.0.0', upTo: '3.1.3', where: 'shared element scenes' },
  { name: 'react-native-walkthrough-tooltip', change: 'rn87-interaction-manager', from: '1.0.0', upTo: '1.7.0', where: 'Tooltip' },
  { name: 'react-native-deprecated-custom-components', change: 'rn87-interaction-manager', from: '0.1.0', upTo: '0.1.2', where: 'Navigator' },
  { name: 'react-native-color-picker', change: 'rn87-interaction-manager', from: '0.6.0', upTo: '0.6.0', where: 'HoloColorPicker' },
  { name: '@shoutem/ui', change: 'rn87-interaction-manager', from: '9.0.0', upTo: '9.2.1', where: 'HorizontalPager' },
  // StatusBar setters (0.87): a crash when that code runs.
  { name: 'react-native-dropdownalert', change: 'rn87-statusbar-props', from: '5.0.0', upTo: '5.2.0', where: 'DropdownAlert' },
  { name: '@shoutem/ui', change: 'rn87-statusbar-props', from: '9.0.0', upTo: '9.2.1', where: 'ListView' },
];

const CODE = /\.(?:m?js|cjs|jsx|ts|tsx)$/;
const NOT_LIBRARY_WIDE = new Set(['@react-native-community/hooks', 'react-native-drax']);
const CORE = /^(?:react-native|react-native-web|react-native-windows|react-native-macos|react-native-tvos|@amazon-devices\/react-native-kepler|@react-native\/.*|@react-native-community\/cli.*)$/;
const SKIP_DIR = /^(?:node_modules|__tests__|__mocks__|test|tests|example|examples|docs|android|ios|website)$/;
const MAX_FILES = 600;
// Comments blanked, line breaks kept (so a line number still points at the real line).
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

export function scanInstalled(dir) {
  const found = {};
  let files = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files >= MAX_FILES || Object.keys(found).length === Object.keys(USES).length) return;
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) walk(f); continue; }
      if (!CODE.test(e.name) || /\.d\.ts$|\.(?:test|spec)\./.test(e.name)) continue;
      files++;
      let text;
      try { if (fs.statSync(f).size > 2 * 1024 * 1024) continue; text = strip(fs.readFileSync(f, 'utf8')); } catch { continue; }
      for (const [id, c] of Object.entries(USES)) {
        if (found[id]) continue;
        const m = c.use.exec(text);
        if (!m || c.own.test(text) || c.guard.test(text)) continue;
        found[id] = `${path.relative(dir, f).split(path.sep).join('/')}:${text.slice(0, m.index).split('\n').length}`;
      }
    }
  };
  walk(dir);
  return found;
}

// Map change id -> [{ name, version, where }] for the app's direct dependencies.
export function removedApiInLibraries(project) {
  const root = project.root;
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch {}
  const deps = { ...(pkg.dependencies || {}) };
  const out = new Map();
  const add = (id, hit) => { if (!out.has(id)) out.set(id, []); out.get(id).push(hit); };
  const locked = lockedVersions(root, deps);
  for (const name of Object.keys(deps)) {
    // React Native itself (and its platform forks) define and use these APIs: it is not a library
    // that lags behind, it is the version being upgraded.
    if (CORE.test(name)) continue;
    // A hook the app has to call (the app-code check finds that call) or a debug-only overlay.
    if (NOT_LIBRARY_WIDE.has(name)) continue;
    const dir = findPackageDir(root, name);
    if (dir) {
      let version = null;
      try { version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch {}
      for (const [id, where] of Object.entries(scanInstalled(dir))) add(id, { name, version, where });
      continue;
    }
    // Not installed: the releases verified by hand, matched on the exact (locked) or declared version.
    const version = locked[name] || cleanVersion(deps[name]);
    if (!version || !/^\d/.test(version)) continue;
    for (const k of KNOWN.filter((x) => x.name === name)) {
      if (compareVersions(version, k.from) >= 0 && compareVersions(version, k.upTo) <= 0) add(k.change, { name, version, where: k.where });
    }
  }
  return out;
}
