import fs from 'node:fs';
import path from 'node:path';
import { cleanVersion, findPackageDir, installedVersion, versionFromSpec } from './project.js';
import { createRegistry, fetchJson } from './registry.js';
import { scanSecrets, TEST_PATH } from './secrets.js';
import { nativeChecks } from './native.js';
import { stabilityChecks } from './stability.js';
import { performanceChecks } from './performance.js';
import { vulnerableDependencies, passwordLeaks, webViewRisks, androidBackup, exportedComponents, plainHttpCalls, cloudRules, insecureTls, weakCrypto, tokenStorage, reverseEngineering, expoConfigSecrets, aiKeysInBundle, deepLinks, supabaseRls, playRestrictedPermissions, masvsOf, MASVS_GROUPS } from './security.js';
import { lockedVersions } from './lockfile.js';
import { storeReviewRules } from './store-rules.js';
import { expoPinnedNames, movesWithExpoSdk } from './expo-pins.js';
import { findUnused, filesImportingWith } from './usage.js';
import { matchKnownIssues, compareVersions } from './known-issues.js';
import { COMPAT, bestRange, checkCompat, needsNewerRn } from './compat.js';
import { interopProblems } from './interop.js';
import {
  CRITICAL_EXPO_MAJORS_BEHIND,
  CRITICAL_RN_MINORS_BEHIND,
  NEW_ARCH_ONLY_MINOR,
  RECENT_RELEASE_DAYS,
  STALE_RELEASE_DAYS,
  PLAY_TARGET_SDK,
  RENAMED,
  REPLACEMENTS,
  PACKAGE_NOTES,
  SUPPORTED_EXPO_MAJORS,
  SUPPORTED_RN_MINORS,
} from './rules.js';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

const minorOf = (v) => Number(v.split('.')[1]);
const majorOf = (v) => Number(v.split('.')[0]);
// For 0.x packages the minor is the breaking-change line.
const lineOf = (v) => {
  const [maj, min] = v.split('.').map(Number);
  return maj === 0 ? `0.${min}` : String(maj);
};

// react, react-native and @react-native/* move together with the React Native version; @babel/* and types are tooling.
// Also packages that move with React Native and React themselves (Metro, the scheduler, react-is).
const isTracked = (name) =>
  !['react-native', 'react', 'expo', 'react-dom', 'react-is', 'react-test-renderer', 'scheduler', 'hermes-engine'].includes(name) &&
  !/^metro(-|$)/.test(name) &&
  !name.startsWith('@react-native/') &&
  !name.startsWith('@babel/') &&
  !name.startsWith('@types/');

function isNativeModule(root, name, dir) {
  const base = findPackageDir(root, name);
  if (base) {
    if (fs.existsSync(path.join(base, 'android')) || fs.existsSync(path.join(base, 'ios'))) return true;
    // A podspec alone is not native code: some JS packages ship one that points at an ios/ folder
    // they do not have (react-native-render-html). Count it only with sources next to it.
    try {
      const entries = fs.readdirSync(base);
      return entries.some((f) => f.endsWith('.podspec')) && entries.some((f) => /^(apple|macos|cpp|common|Sources|src-native|native)$/.test(f) || /\.(m|mm|swift|h)$/.test(f));
    } catch {
      return false;
    }
  }
  // Known without looking: React Navigation is JavaScript only (the directory reports its
  // monorepo as native), and the renamed community packages all contain native code (some
  // were removed from the directory).
  if (/^@react-navigation\//.test(name)) return false;
  if (RENAMED[name]) return true;
  // Without node_modules, ask React Native Directory. Its ios/android flags mean "works on",
  // not "has native code" (pure JS packages set them too), so prefer its hasNativeCode.
  if (dir && dir.github && typeof dir.github.hasNativeCode === 'boolean') return dir.github.hasNativeCode;
  return !!(dir && (dir.ios || dir.android) && !dir.web);
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Expo's pins are ~x.y.z (same minor), ^x.y.z (same major), or an exact version.
export function satisfiesExpoRange(version, range) {
  const m = String(range).trim().match(/^([~^]?)\s*(\d+)\.(\d+)\.(\d+)/);
  if (!m) return true; // a range we do not understand: do not second-guess Expo
  const [maj, min] = version.split('.').map(Number);
  if (compareVersions(version, `${m[2]}.${m[3]}.${m[4]}`) < 0) return false;
  if (m[1] === '^') return maj === Number(m[2]);
  if (m[1] === '~') return maj === Number(m[2]) && min === Number(m[3]);
  return compareVersions(version, `${m[2]}.${m[3]}.${m[4]}`) === 0;
}

// `offline: true` means the user asked for no network access (get returns nothing).
export async function analyze(project, { get, now = new Date(), offline: forcedOffline = false } = {}) {
  // Requests that failed even after retries (rate limits, network): reported, never hidden.
  const net = { failed: 0, deadline: Date.now() + (Number(process.env.NATIVEKEEL_NETWORK_BUDGET_MS) || 90000) };
  const registry = createRegistry(get || ((url, headers, body) => fetchJson(url, headers, net, { body })));
  const findings = [];
  const add = (f) => findings.push(f);

  // Packages from the same monorepo (workspace:, link:, file:, portal:) are developed in the repo:
  // npm's copy of the name (if any) says nothing about them.
  const local = (n) => /^(workspace|link|file|portal):/.test(String(project.deps[n] || project.devDeps[n] || ''));
  const runtime = Object.keys(project.deps).filter((n) => isTracked(n) && !local(n));
  const devCandidates = Object.keys(project.devDeps || {}).filter((n) => isTracked(n) && !local(n) && !runtime.includes(n));
  const [rn, expo, directory] = await Promise.all([
    project.rnVersion ? registry.releaseLines('react-native', (v) => (v.startsWith('0.') ? minorOf(v) : NaN)) : null,
    project.expoVersion ? registry.releaseLines('expo', majorOf) : null,
    registry.directoryInfo([...runtime, ...devCandidates]),
  ]);
  // From devDependencies only native modules matter: they get autolinked into the app.
  const devNative = devCandidates.filter((n) => isNativeModule(project.root, n, directory[n]));
  const names = [...runtime, ...devNative];
  const declaredRange = (n) => project.deps[n] || project.devDeps[n];
  const latest = await registry.npmLatest(names);
  const offline = forcedOffline || (!rn && !Object.keys(directory).length && !Object.values(latest).some(Boolean));
  const warnings = [];
  if (!project.hasNodeModules) {
    warnings.push('node_modules not found: versions are read from package.json ranges and native detection is less accurate. Install dependencies for a precise report.');
  }
  const rnSpec = project.deps['react-native'] || project.devDeps['react-native'];
  if (!project.rnVersion && rnSpec) {
    warnings.push(`React Native is declared as "${rnSpec}", which has no version number (a git fork or a workspace reference). Install dependencies so NativeKeel can read the installed version; version checks were skipped.`);
  }
  if (project.isLibrary) {
    warnings.push('This looks like a React Native library, not an app (react-native is a peer dependency, or android/ builds a library). App Store and Google Play checks were skipped; scan the app that uses it for those.');
  }
  const reportIncomplete = () => {
    if (net.failed && !offline) warnings.push(`${net.failed} request${net.failed === 1 ? '' : 's'} to npm or React Native Directory failed (rate limit or network), so some dependency checks may be missing. Run again in a few minutes (a slow network stops after 90 seconds rather than hanging).`);
  };
  if (!offline && project.rnVersion && !rn) warnings.push('Could not fetch React Native releases from npm; version and New Architecture checks were skipped. Run again.');
  if (!offline && project.expoVersion && !expo) warnings.push('Could not fetch Expo releases from npm; the SDK check was skipped. Run again.');

  // 1. React Native version support
  const current = project.rnVersion;
  // In an Expo project the SDK pins React Native: upgrading the SDK is how React Native moves,
  // so the Expo finding carries the severity and this one only explains the link.
  const rnFollowsExpo = !!(project.expoVersion && expo);
  if (rn && current) {
    const behind = rn.lines[0] - minorOf(current);
    if (rnFollowsExpo && behind > 0) {
      add({
        id: 'rn-via-expo',
        severity: 'info',
        area: 'react-native',
        title: `React Native ${current} comes with Expo SDK ${majorOf(project.expoVersion)}`,
        detail: `Latest React Native is ${rn.latest} (${behind} minor${behind === 1 ? '' : 's'} behind). Upgrading the Expo SDK upgrades React Native with it.`,
      });
    } else if (behind >= SUPPORTED_RN_MINORS) {
      add({
        id: 'rn-unsupported',
        severity: behind >= CRITICAL_RN_MINORS_BEHIND ? 'critical' : 'high',
        area: 'react-native',
        title: `React Native ${current} is no longer supported`,
        detail: `Latest is ${rn.latest}. You are ${behind} minor versions behind; only the latest ${SUPPORTED_RN_MINORS} minors receive fixes.`,
        fix: { kind: 'upgrade-rn', from: current, to: rn.latest },
      });
    } else if (behind > 0) {
      add({
        id: 'rn-behind',
        severity: 'info',
        area: 'react-native',
        title: `React Native ${current} is still supported`,
        detail: `Latest is ${rn.latest} (${behind} minor behind).`,
        fix: { kind: 'upgrade-rn', from: current, to: rn.latest },
      });
    }

    // 2. New Architecture
    // Not set means the default: off before 0.76, on from 0.76.
    const unset = minorOf(current) < 76 ? ['android', 'ios'].filter((p) => project.newArch[p] === null) : [];
    const off = ['android', 'ios'].filter((p) => project.newArch[p] === false || unset.includes(p));
    if (minorOf(current) < NEW_ARCH_ONLY_MINOR && off.length && rn.lines[0] >= NEW_ARCH_ONLY_MINOR) {
      add({
        id: 'new-arch-disabled',
        severity: 'critical',
        area: 'new-architecture',
        title: `New Architecture is ${unset.length === off.length ? 'off' : 'disabled'} (${off.join(' + ')})`,
        detail: `${unset.length ? `Not set, and before React Native 0.76 the default is off. ` : ''}The legacy architecture was removed in 0.${NEW_ARCH_ONLY_MINOR}. This app cannot upgrade past 0.${NEW_ARCH_ONLY_MINOR - 1} until it migrates.`,
        fix: { kind: 'enable-new-arch', platforms: off },
      });
    }
  }

  // 3. Expo SDK support
  if (expo && project.expoVersion) {
    const behind = expo.lines[0] - majorOf(project.expoVersion);
    if (behind >= SUPPORTED_EXPO_MAJORS) {
      add({
        id: 'expo-unsupported',
        severity: behind >= CRITICAL_EXPO_MAJORS_BEHIND ? 'critical' : 'high',
        area: 'expo',
        title: `Expo SDK ${majorOf(project.expoVersion)} is no longer supported`,
        detail: `Latest is SDK ${expo.lines[0]}. Upgrade one SDK at a time with \`npx expo install expo@^<next> --fix\`.`,
        fix: { kind: 'upgrade-expo', from: majorOf(project.expoVersion), to: expo.lines[0] },
      });
    } else if (behind > 0) {
      add({
        id: 'expo-behind',
        severity: 'info',
        area: 'expo',
        title: `Expo SDK ${majorOf(project.expoVersion)} is still supported`,
        detail: `Latest is SDK ${expo.lines[0]}.`,
        fix: { kind: 'upgrade-expo', from: majorOf(project.expoVersion), to: expo.lines[0] },
      });
    }
  }

  // 4. Google Play target SDK
  const target = !project.isLibrary && project.android && project.android.targetSdk;
  if (target) {
    const today = now.toISOString().slice(0, 10);
    const { updates, visibility } = PLAY_TARGET_SDK;
    if (today >= visibility.since && target < visibility.minimum) {
      add({
        id: 'play-target-sdk-visibility',
        severity: 'critical',
        area: 'store',
        title: `targetSdk ${target} hides the app from users on newer Android versions`,
        detail: `Since ${visibility.since} Google Play requires API ${visibility.minimum}+ for published apps to stay visible, and API ${updates.minimum}+ to publish any update.`,
        fix: { kind: 'target-sdk', from: target, to: updates.minimum },
      });
    } else if (today >= updates.since && target < updates.minimum) {
      add({
        id: 'play-target-sdk-updates',
        severity: 'critical',
        area: 'store',
        title: `targetSdk ${target}: Google Play will reject your next update`,
        detail: `Since ${updates.since} new apps and updates must target API ${updates.minimum}+${today <= updates.extensionUntil ? ` (an extension you request in Play Console runs until ${updates.extensionUntil} at the latest)` : '; the extension period has ended'}.`,
        fix: { kind: 'target-sdk', from: target, to: updates.minimum },
      });
    }
  }

  // 5. Dependencies
  // React Native Directory knows most packages, but its "unmaintained" flag can lag reality in
  // both directions. For packages it does not know, or flags as unmaintained, the date of the
  // latest npm release decides.
  const recencyCandidates = names.filter((n) => !directory[n] || directory[n].unmaintained);
  const published = forcedOffline ? {} : await registry.publishDates(recencyCandidates);
  const daysSince = (date) => (date ? Math.floor((now - new Date(`${date}T00:00:00Z`)) / 86400000) : null);

  const nativeOf = Object.fromEntries(names.map((n) => [n, isNativeModule(project.root, n, directory[n])]));
  const versionOf = (n) => cleanVersion(installedVersion(project.root, n) || versionFromSpec(n, declaredRange(n)) || '');
  const archSuspects = names.filter((n) => nativeOf[n] && directory[n] && directory[n].newArchitecture === false);
  const codegen = forcedOffline ? {} : await registry.codegenSupport(archSuspects.map((n) => ({ name: n, version: versionOf(n) })));

  const deps = [];
  let pinnedCache = null;
  const expoPinned = () => (pinnedCache ||= expoPinnedNames(project.root));
  for (const name of names) {
    const dir = directory[name];
    const version = versionOf(name);
    const native = nativeOf[name];
    const release = published[name] || {};
    const age = daysSince(release.date);
    const revived = !!(dir && dir.unmaintained && age !== null && age <= RECENT_RELEASE_DAYS);
    const dep = {
      name,
      version,
      latest: latest[name] || null,
      native,
      newArch: dir ? dir.newArchitecture : undefined,
      unmaintained: !!(dir && dir.unmaintained) && !revived,
      lastRelease: release.date || null,
    };
    deps.push(dep);

    const cg = codegen[name];
    // Directory says no New Architecture, but npm may know better.
    const archFixedIn = native && dir && dir.newArchitecture === false && cg && !cg.usedHas && cg.latestHas ? cg.latest : null;
    const noNewArch = native && dir && dir.newArchitecture === false && !(cg && (cg.usedHas || cg.latestHas));
    if (cg && cg.usedHas) dep.newArch = true;
    if (archFixedIn) {
      add({
        id: `dep-risk:${name}`,
        severity: 'medium',
        area: 'dependency',
        title: `${name} ${version || ''}: New Architecture support needs ${archFixedIn}`.replace('  ', ' '),
        detail: `React Native Directory lists it without New Architecture support, but ${archFixedIn} ships a codegen spec. Update to ${archFixedIn} (check its changelog for breaking changes) instead of replacing it.`,
        fix: { kind: 'bump-dep', name, from: version, to: archFixedIn, native },
      });
      continue;
    }
    // Only code that has to follow React Native or the OS goes stale; a finished JS utility does not.
    const stale = !dep.unmaintained && !revived && age !== null && age > STALE_RELEASE_DAYS && (native || !!release.rnLink);
    const alternatives = RENAMED[name] ? [RENAMED[name]] : dir && dir.alternatives && dir.alternatives.length ? dir.alternatives : REPLACEMENTS[name] || [];
    if (noNewArch || dep.unmaintained || stale) {
      const problems = [
        noNewArch && 'no New Architecture support',
        dep.unmaintained && 'unmaintained',
        stale && `no release since ${release.date.slice(0, 7)}`,
      ].filter(Boolean);
      const why = noNewArch
        ? 'Likely upgrade blocker (it may still run through the interop layer). Plan a replacement or a maintained fork.'
        : 'No fixes will come for future React Native, iOS or Android releases.';
      add({
        id: `dep-risk:${name}`,
        // A general-purpose JS utility (clsx, lodash-style helpers) does not affect React Native
        // upgrades even when unmaintained: low. React Native/Expo-specific JS packages stay medium.
        severity: noNewArch || native ? 'high' : (stale && !dep.unmaintained && release.rnLink === 'name') || (release && !release.rnLink && !/react-native|expo|^@react-navigation\//.test(name)) ? 'low' : 'medium',
        area: 'dependency',
        title: `${name}: ${problems.join(', ')}`,
        detail: `${why}${alternatives.length ? ` Alternatives: ${alternatives.join(', ')}.` : ''}${PACKAGE_NOTES[name] ? ` ${PACKAGE_NOTES[name]}` : ''}`,
        fix: { kind: 'replace-dep', name, native, noNewArch, unmaintained: dep.unmaintained || stale, alternatives, renamedTo: RENAMED[name] || null },
      });
    } else if (revived) {
      add({
        id: `dep-revived:${name}`,
        severity: 'info',
        area: 'dependency',
        title: `${name}: marked unmaintained, but ${release.date} saw a new release`,
        detail: 'React Native Directory still lists it as unmaintained. Maintenance may have resumed; check the changelog and issue tracker before replacing it.',
      });
    }
    // Only when npm's latest is newer: a prerelease of the next major (8.0.0-alpha while latest is
    // 7.x) is ahead, and suggesting the latest would be a downgrade.
    if (!noNewArch && !dep.unmaintained && !stale && version && dep.latest && lineOf(version) !== lineOf(dep.latest) && compareVersions(dep.latest, version) > 0) {
      // In Expo apps the SDK decides these versions: the SDK upgrade moves them, no separate work.
      const expoManaged = !!project.expoVersion && movesWithExpoSdk(name, expoPinned());
      add({
        id: `dep-major:${name}`,
        severity: expoManaged ? 'info' : 'low',
        area: 'dependency',
        title: `${name} ${version} → ${dep.latest}`,
        detail: expoManaged ? 'Major version behind; the Expo SDK upgrade moves it.' : 'Major version behind.',
        fix: { kind: 'bump-dep', name, from: version, to: dep.latest, native, expoManaged },
      });
    }
  }

  // Native libraries that need a newer React Native than the app has (a library bumped ahead
  // of React Native): they use APIs that do not exist yet, so the build or the first call fails.
  const rnNow = project.rnVersion && cleanVersion(project.rnVersion);
  if (rnNow && !project.expoVersion) {
    const locked = lockedVersions(project.root, project.deps);
    const ranges = {};
    const ask = [];
    for (const d of deps.filter((x) => x.native && project.deps[x.name])) {
      const dir = findPackageDir(project.root, d.name);
      const local = dir && readJsonFile(path.join(dir, 'package.json'));
      if (local) {
        if (local.peerDependencies && local.peerDependencies['react-native']) ranges[d.name] = { range: local.peerDependencies['react-native'], version: local.version };
      } else if (locked[d.name] && /^\d+\.\d+\.\d+$/.test(locked[d.name])) ask.push({ name: d.name, version: locked[d.name] });
    }
    if (ask.length && !forcedOffline) {
      const fetched = await registry.peerRanges(ask.slice(0, 40));
      for (const a of ask) if (fetched[a.name]) ranges[a.name] = { range: fetched[a.name], version: a.version };
    }
    const ahead = Object.entries(ranges)
      .map(([name, { range, version }]) => ({ name, version, range, needs: needsNewerRn(range, rnNow) }))
      .filter((x) => x.needs);
    if (ahead.length) {
      add({
        id: 'crash-needs-newer-rn',
        severity: 'high',
        area: 'crash',
        title: `${ahead.length} native librar${ahead.length === 1 ? 'y needs' : 'ies need'} a newer React Native than ${rnNow} (${ahead.slice(0, 3).map((x) => `${x.name} ${x.version}`).join(', ')})`,
        detail: `${ahead.map((x) => `${x.name} ${x.version} requires react-native ${x.range}`).join('; ')}. Each library declares it needs that React Native; below it, builds commonly fail or the first call crashes, because it uses APIs your version does not have. Install the newest release of each that supports ${rnNow}, or upgrade React Native first.`,
        fix: { kind: 'crash', step: `Pin ${ahead.map((x) => `\`${x.name}\``).join(', ')} to the last release that supports React Native ${rnNow} (check each changelog), or upgrade React Native before them.` },
      });
    }
  }

  // Unused runtime dependencies: removing them is cheaper than upgrading them.
  const unused = new Set();
  for (const u of findUnused(project)) {
    unused.add(u.name);
    add({
      id: `unused:${u.name}`,
      severity: u.native ? 'medium' : 'low',
      area: 'dependency',
      title: `${u.name} is installed but never used${u.native ? ' (native module)' : ''}`,
      detail: `Not imported from JS, not referenced from native code, not required by another dependency.${u.native ? ' It still compiles into both apps and has to survive every upgrade.' : ''} Remove it.`,
      fix: { kind: 'remove-dep', name: u.name, native: u.native },
    });
  }
  // A package you are about to delete does not need upgrade advice.
  for (let i = findings.length - 1; i >= 0; i--) {
    const f = findings[i];
    if (f.fix && ['replace-dep', 'bump-dep'].includes(f.fix.kind) && unused.has(f.fix.name)) findings.splice(i, 1);
  }

  // Known version-specific breakages, learned from real upgrades.
  const newArchOn = project.newArch.android !== false && project.newArch.ios !== false && minorOf(current || '0.0') >= 76;
  // The legacy architecture ends at 0.81, so any older app with it off has to migrate; this
  // holds even when the latest release could not be fetched (offline).
  const archOff = project.newArch.android === false || project.newArch.ios === false || (!!current && minorOf(current) < 76 && (project.newArch.android === null || project.newArch.ios === null));
  const newArchRequired =
    findings.some((f) => f.id === 'new-arch-disabled') || (archOff && current && minorOf(current) < NEW_ARCH_ONLY_MINOR);
  for (const { issue, dep } of matchKnownIssues({ deps, rnVersion: current, newArchOn, newArchRequired })) {
    let { severity, title, detail } = issue;
    if (issue.evidence) {
      const files = filesImportingWith(project.root, issue.evidence.imports, issue.evidence.pattern);
      if (files.length) {
        detail = `Found in ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}. ${detail}`;
      } else {
        ({ severity, title, detail } = { ...issue, ...issue.withoutEvidence });
      }
    }
    add({
      id: `known:${issue.id}`,
      severity,
      area: 'dependency',
      title,
      detail: `${detail} (installed: ${dep.name} ${dep.version}; seen in: ${issue.source})`,
      fix: { kind: 'known-issue', name: dep.name, title, detail, severity },
    });
  }

  // Library ↔ React Native compatibility, from the libraries' own tables.
  // Expo SDKs pin tested versions of these libraries (bundledNativeModules.json). A version
  // inside Expo's range is a combination Expo ships, even where the library's table is stricter.
  const expoDir = project.expoVersion ? findPackageDir(project.root, 'expo') : null;
  // Exact versions of what is installed (node_modules, else the lockfile).
  const lockedAll = lockedVersions(project.root, project.deps);
  const exactOf = (n) => installedVersion(project.root, n) || (/^\d+\.\d+\.\d+/.test(lockedAll[n] || '') ? lockedAll[n] : null);
  let expoPins = expoDir ? readJsonFile(path.join(expoDir, 'bundledNativeModules.json')) : null;
  const expoExact = project.expoVersion ? exactOf('expo') : null;
  if (!expoPins && expoExact && !forcedOffline) expoPins = await registry.expoPins(expoExact);
  const expoSdk = project.expoVersion ? majorOf(project.expoVersion) : null;
  // A React Native ahead of the latest stable (a release candidate) is not in the libraries'
  // compatibility tables yet: say so instead of calling every library incompatible.
  const aheadOfStable = !!(current && rn && rn.latest && minorOf(current) > minorOf(rn.latest));
  if (aheadOfStable) {
    add({
      id: 'rn-prerelease',
      severity: 'info',
      area: 'react-native',
      title: `React Native ${current}${project.rnPrerelease ? `-${project.rnPrerelease}` : ''} is ahead of the latest stable release (${rn.latest})`,
      detail: 'Library compatibility tables do not cover it yet, so version checks for Reanimated, Gesture Handler and Screens are skipped. Check each library\'s release notes for this React Native version.',
    });
  }
  if (current && !aheadOfStable) {
    const rnMinor = minorOf(current);
    // react-native.config.js can build a library's native side from another folder (Edge links
    // Reanimated 3 on its legacy-architecture Android build through a shim, Reanimated 4 on iOS).
    // The installed version then says nothing about the architecture that build runs on.
    let rnConfig = '';
    try {
      rnConfig = fs.readFileSync(path.join(project.root, 'react-native.config.js'), 'utf8');
    } catch {}
    const ownNative = (name) => new RegExp(`['"]${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}['"]\\s*:\\s*\\{[^}]{0,400}sourceDir`).test(rnConfig);
    for (const dep of deps.filter((d) => COMPAT[d.name])) {
      const pinned = expoPins && expoPins[dep.name];
      if (pinned && dep.version && satisfiesExpoRange(dep.version, pinned)) continue;
      const problem = !newArchOn && ownNative(dep.name) ? null : checkCompat(dep.name, dep.version, rnMinor, newArchOn);
      // Also check the architecture this app has to move to.
      const ahead = !problem && newArchRequired ? checkCompat(dep.name, dep.version, rnMinor, true) : null;
      if (!problem && !ahead) continue;
      const best = bestRange(dep.name, rnMinor, problem ? newArchOn : true);
      let expoNote = '';
      if (pinned) expoNote = ` Expo SDK ${expoSdk} expects ${pinned}: run \`npx expo install --fix\`.`;
      else if (expoSdk) expoNote = ` Expo SDK ${expoSdk} pins a tested version of this package; \`npx expo install --check\` shows whether yours matches (install dependencies for a precise check).`;
      add({
        id: `compat:${dep.name}`,
        severity: problem && !(expoSdk && !pinned) ? 'high' : 'medium',
        area: 'dependency',
        title: problem || `${ahead} (needed for the New Architecture)`,
        detail: `${best ? `Use ${dep.name} ${best.range} on React Native ${current}. ` : ''}Source: ${COMPAT[dep.name].source}.${COMPAT[dep.name].note ? ` ${COMPAT[dep.name].note}` : ''}${expoNote}`,
        fix: { kind: 'compat', name: dep.name, range: best && best.range, forNewArch: !problem },
      });
    }
  }

  // Native modules that cannot load through the New Architecture interop layer (Android).
  const androidNewArch = project.newArch.android !== false && minorOf(current || '0.0') >= 76;
  if (androidNewArch || newArchRequired) {
    for (const p of interopProblems(project, deps)) {
      add({
        id: `interop-job:${p.name}`,
        severity: androidNewArch ? 'critical' : 'high',
        area: 'new-architecture',
        title: `${p.name} will not load on Android with the New Architecture (${p.methods.length} @ReactMethod${p.methods.length === 1 ? '' : 's'} return a coroutine Job)`,
        detail: `${p.methods.slice(0, 4).join(', ')}${p.methods.length > 4 ? ', …' : ''} are written as \`fun x(...) = scope.launch { }\`. The interop layer only accepts void methods ("Unable to parse @ReactMethod ... unsupported return class: kotlinx.coroutines.Job"), so the whole module fails to load; if it is imported at startup the app shows a red screen. Patch the methods to return Unit (patch-package) or move to a version with a TurboModule spec.`,
        fix: { kind: 'interop-job', name: p.name, methods: p.methods },
      });
    }
  }

  // 6. Native project: store requirements, built binaries, security settings
  findings.push(...nativeChecks(project, { rnLatest: rn && rn.latest, now }));

  // 7. Secrets
  // Setups that build and then crash at runtime.
  for (const f of stabilityChecks(project)) add(f);
  // Static signs of performance problems.
  for (const f of performanceChecks(project)) add(f);

  // Packages off the versions the Expo SDK pins (what `npx expo install --check` reports). Older
  // than the SDK expects is a common build failure or launch crash; newer is usually a choice the
  // team made (and `--fix` would downgrade it). Packages in package.json `expo.install.exclude`
  // (Expo's own opt-out) are skipped.
  if (expoPins && project.expoVersion) {
    const pkgJson = readJsonFile(path.join(project.root, 'package.json')) || {};
    const excluded = new Set(((pkgJson.expo && pkgJson.expo.install && pkgJson.expo.install.exclude) || []).map(String));
    const off = [];
    const reported = new Set(findings.filter((f) => f.id.startsWith('compat:')).map((f) => f.id.slice(7)));
    for (const [name, range] of Object.entries(expoPins)) {
      if (!project.deps[name] || ['expo', 'react', 'react-native', 'react-dom', 'react-native-web'].includes(name) || reported.has(name) || excluded.has(name)) continue;
      const v = exactOf(name);
      if (!v || satisfiesExpoRange(v, range)) continue;
      const want = String(range).replace(/^[~^>=\s]+/, '');
      const level = majorOf(v) !== majorOf(want) ? 'major' : minorOf(v) !== minorOf(want) ? 'minor' : 'patch';
      off.push({ name, v, range, level, newer: compareVersions(v, want) > 0 });
    }
    if (off.length) {
      const rank = (o) => (o.newer ? { major: 1, minor: 0, patch: 0 } : { major: 3, minor: 2, patch: 0 })[o.level];
      const worst = Math.max(...off.map(rank));
      const sev = ['low', 'medium', 'medium', 'high'][worst];
      off.sort((a, b) => rank(b) - rank(a));
      const older = off.filter((o) => !o.newer);
      const newer = off.filter((o) => o.newer);
      const line = (o) => `${o.name} ${o.v} (SDK ${expoSdk} expects ${o.range}${o.level === 'patch' ? '' : `, a ${o.level} difference`}${o.newer ? ', newer' : ''})`;
      add({
        id: 'expo-sdk-mismatch',
        severity: sev,
        area: 'crash',
        title: `${off.length} package${off.length === 1 ? ' is' : 's are'} not the version Expo SDK ${expoSdk} expects (${off.slice(0, 3).map((o) => o.name).join(', ')}${off.length > 3 ? ', …' : ''})`,
        detail: `${off.slice(0, 8).map(line).join('; ')}${off.length > 8 ? '; …' : ''}.${older.length ? ` Expo tests each SDK with its versions; native modules older than that are a common cause of build failures and launch crashes: \`npx expo install --fix\` sets them.` : ''}${newer.length ? ` ${newer.length === off.length ? 'All are newer' : `${newer.length} ${newer.length === 1 ? 'is' : 'are'} newer`} than the SDK expects, which is usually a deliberate choice: if you tested ${newer.length === 1 ? 'it' : 'them'}, list ${newer.length === 1 ? 'it' : 'them'} in \`expo.install.exclude\` in package.json (\`--fix\` would downgrade ${newer.length === 1 ? 'it' : 'them'}).` : ''}`.trim(),
        fix: { kind: 'crash', step: older.length ? `Run \`npx expo install --fix\` to put ${older.slice(0, 4).map((o) => `\`${o.name}\``).join(', ')}${older.length > 4 ? ' and the rest' : ''} on the versions Expo SDK ${expoSdk} expects, then rebuild${newer.length ? '; list the deliberately newer ones in `expo.install.exclude` first' : ''}.` : `Confirm the newer ${newer.slice(0, 4).map((o) => `\`${o.name}\``).join(', ')} ${newer.length === 1 ? 'works' : 'work'} with Expo SDK ${expoSdk}, then list ${newer.length === 1 ? 'it' : 'them'} in \`expo.install.exclude\` in package.json.` },
      });
    }
  }

  // Security beyond leaked keys.
  for (const f of [...passwordLeaks(project.root), ...webViewRisks(project.root), ...androidBackup(project.root), ...exportedComponents(project.root), ...plainHttpCalls(project.root), ...cloudRules(project.root, project.deps, now), ...insecureTls(project.root), ...weakCrypto(project.root), ...tokenStorage(project.root), ...reverseEngineering(project.root, project), ...expoConfigSecrets(project.root), ...aiKeysInBundle(project.root, { ...project.devDeps, ...project.deps }), ...deepLinks(project.root, project.deps), ...supabaseRls(project.root), ...(project.isLibrary ? [] : playRestrictedPermissions(project.root, project.deps))]) add(f);
  if (!forcedOffline) {
    // Exact versions only (installed, else the lockfile): a range would be a guess.
    const locked = lockedVersions(project.root, project.deps);
    const exact = {};
    for (const name of Object.keys(project.deps)) {
      // Advisories describe npm registry packages. A dependency from git, a URL or a local
      // path is a different package that only shares the name (e.g. a squatted name with a
      // malware advisory), so it is not matched.
      if (/:\/\/|^(github|gitlab|bitbucket|git|file|link|workspace|portal|patch):|^[\w.-]+\/[\w.-]+(#|$)/.test(String(project.deps[name]))) continue;
      const v = installedVersion(project.root, name) || locked[name];
      if (v && /^\d+\.\d+\.\d+/.test(v)) exact[name] = v;
    }
    const vulns = await vulnerableDependencies(registry, exact, latest);
    if (vulns === null) net.failed++;
    for (const f of vulns || []) add(f);
  }

  for (const s of scanSecrets(project.root)) {
    const value = s.preview ? `Value ${s.preview}. ` : '';
    const where = `${s.file}:${s.line}`;
    if (s.inAppBundle) {
      add({
        id: `secret:${s.rule}:${s.file}`,
        severity: 'critical',
        area: 'secret',
        title: `${s.label} shipped inside the app (${where})`,
        detail: `${value}Anyone who downloads the app can extract it. Revoke it now, then move the call to a server.`,
        fix: { kind: 'secret', label: s.label, file: s.file, line: s.line, bundled: true },
      });
    } else if (s.committed !== false && s.inComment) {
      add({
        id: `secret:${s.rule}:${s.file}`,
        severity: 'medium',
        area: 'secret',
        title: `${s.label} in a commented-out line (${where})`,
        detail: `${value}Comments are not shipped in the app, but the line is in the repository and its git history. If the value is real, rotate it; either way, delete the line.`,
        fix: { kind: 'secret', label: s.label, file: s.file, line: s.line, bundled: false },
      });
    } else if (s.committed !== false && s.rule === 'private-key' && TEST_PATH.test(s.file.split(path.sep).join('/'))) {
      // A key pair made for a test (Edge signs and verifies a sample payload with one) unlocks
      // nothing, unless the same key is also used for real.
      add({
        id: `secret:${s.rule}:${s.file}`,
        severity: 'low',
        area: 'secret',
        title: `Private key in a test file (${where})`,
        detail: `${value}Test code is not shipped, and a key generated for a test protects nothing. Make sure it is not also used by a real server or service; if it is, rotate it.`,
        fix: { kind: 'secret', label: s.label, file: s.file, line: s.line, bundled: false },
      });
    } else if (s.committed !== false) {
      add({
        id: `secret:${s.rule}:${s.file}`,
        severity: 'high',
        area: 'secret',
        title: `${s.label} committed to the repository (${where})`,
        detail: `${value}Not shipped in the app, but everyone with repo access has it and it stays in git history. Rotate it and load it from the environment instead.`,
        fix: { kind: 'secret', label: s.label, file: s.file, line: s.line, bundled: false },
      });
    }
  }

  reportIncomplete();
  // OWASP MASVS group for every security finding, and a per-group count (zero means checked, clean).
  const security = Object.fromEntries(Object.keys(MASVS_GROUPS).map((g) => [g, 0]));
  for (const f of findings) {
    const g = masvsOf(f.id);
    if (!g) continue;
    f.masvs = g;
    if (f.severity !== 'info') security[g]++;
  }
  findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  return {
    tool: 'nativekeel',
    scannedAt: now.toISOString(),
    project: {
      name: project.name,
      root: project.root,
      reactNative: project.rnVersion && project.rnPrerelease ? `${project.rnVersion}-${project.rnPrerelease}` : project.rnVersion,
      expo: project.expoVersion,
      managed: project.managed,
      newArch: project.newArch,
      android: project.android,
    },
    latest: { reactNative: rn && rn.latest, expo: expo && expo.latest },
    security,
    offline,
    offlineRequested: forcedOffline,
    warnings,
    deps,
    findings,
  };
}

export const countBySeverity = (findings) =>
  Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]));
