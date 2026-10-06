import fs from 'node:fs';
import path from 'node:path';
import { UPGRADE_HELPER_URL, NEW_ARCH_ONLY_MINOR } from './rules.js';
import { SITE_URL } from './config.js';
import { COMPAT, bestRange } from './compat.js';
import { compareVersions } from './known-issues.js';
import { expoPinnedNames, movesWithExpoSdk } from './expo-pins.js';

// Turns a scan result into an ordered upgrade plan. The order matters more than the steps:
// stop leaks first, then remove blockers, switch architecture on the current version,
// and only then move React Native itself.

function packageManager(root) {
  let dir = root;
  while (true) {
    if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(dir, 'bun.lockb')) || fs.existsSync(path.join(dir, 'bun.lock'))) return 'bun';
    if (fs.existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
    const parent = path.dirname(dir);
    if (parent === dir) return 'npm';
    dir = parent;
  }
}

const commands = {
  npm: { add: 'npm install', remove: 'npm uninstall' },
  yarn: { add: 'yarn add', remove: 'yarn remove' },
  pnpm: { add: 'pnpm add', remove: 'pnpm remove' },
  bun: { add: 'bun add', remove: 'bun remove' },
};

// Intermediate stops roughly every three minors keep each diff reviewable.
export function upgradeHops(from, to) {
  const start = Number(from.split('.')[1]);
  const end = Number(to.split('.')[1]);
  const hops = [];
  for (let m = start + 3; m < end; m += 3) hops.push(`0.${m}.0`);
  hops.push(to);
  return hops;
}

const WEIGHTS = {
  'upgrade-rn': (f) => Number(f.to.split('.')[1]) - Number(f.from.split('.')[1]),
  'upgrade-expo': (f) => (f.to - f.from) * 2,
  'enable-new-arch': () => 6,
  'replace-dep': (f) => (f.noNewArch ? 4 : f.native ? 3 : 1),
  'bump-dep': (f) => (f.native ? 1 : 0.5),
  secret: (f) => (f.bundled ? 2 : 1),
  'target-sdk': () => 2,
  'align-16kb': (f) => f.libs.length,
  'privacy-manifest': () => 1,
  'remove-flipper': () => 1,
  'enable-hermes': () => 2,
  manifest: () => 0.5,
  ats: () => 0.5,
  'min-sdk': () => 1,
  'ios-min': () => 1,
  'remove-dep': () => 0.25,
  'known-issue': () => 1,
  compat: () => 1,
  'app-dependency-provider': () => 1,
  'interop-job': () => 2,
  'podfile-cli-require': () => 0.25,
  rctappdelegate: () => 2,
  'patch-artifacts': () => 0.5,
  'patch-version': () => 1,
  'folly-flags': () => 0.25,
  'default-react-host': () => 0.25,
  crash: () => 1,
  performance: () => 0.5,
  security: () => 1,
  'vuln-dep': (f) => (f.severity === 'critical' || f.severity === 'high' ? 1 : 0.25),
};

// Routine version bumps are many but cheap next to a React Native, architecture or store
// change; capping them keeps a nearly current app with many outdated packages from being sized
// like a migration.
const BUMP_CAPS = { native: 6, js: 2 };

export function complexity(findings) {
  let nativeBumps = 0;
  let jsBumps = 0;
  let rest = 0;
  for (const f of findings) {
    if (!f.fix || !WEIGHTS[f.fix.kind]) continue;
    const w = WEIGHTS[f.fix.kind](f.fix);
    if (f.fix.kind === 'bump-dep') {
      if (f.fix.native) nativeBumps += w;
      else jsBumps += w;
    } else {
      rest += w;
    }
  }
  const score = Math.round(rest + Math.min(nativeBumps, BUMP_CAPS.native) + Math.min(jsBumps, BUMP_CAPS.js));
  const size = score < 8 ? 'Small' : score < 20 ? 'Medium' : score < 40 ? 'Large' : 'Extra large';
  return { score, size };
}

// UI test tooling the project already has, so the plan can say "run yours" instead of
// "write some". Looks for Maestro flows and the common e2e runners.
export function existingUiTests(root, installed) {
  for (const name of ['detox', 'appium', 'webdriverio', '@wdio/cli']) {
    if (installed.has(name)) return name === 'detox' ? 'Detox' : 'Appium';
  }
  for (const dir of ['.maestro', 'maestro', 'e2e', '.e2e']) {
    try {
      const files = fs.readdirSync(path.join(root, dir), { recursive: true });
      if (files.some((f) => /\.ya?ml$/.test(String(f)))) {
        const text = files
          .filter((f) => /\.ya?ml$/.test(String(f)))
          .slice(0, 20)
          .map((f) => fs.readFileSync(path.join(root, dir, String(f)), 'utf8'))
          .join('\n');
        if (/^appId:/m.test(text)) return 'Maestro';
      }
    } catch {
      // no such directory
    }
  }
  return null;
}

function safetyNetPhase(tool) {
  const why =
    'A build that compiles and launches can still crash after login or hide a button. On a real upgrade, UI flows caught three such bugs that build and launch checks missed.';
  if (tool) {
    return {
      title: 'Set up a safety net',
      why,
      steps: [
        `Run your ${tool} suite on both platforms on the current version before changing anything, and keep the results as the baseline.`,
        'Make sure it covers what users do first: launch, sign-in with a test account, and every tab or main screen. Add flows where it does not.',
        'Run it again at the end of every phase below.',
      ],
    };
  }
  return {
    title: 'Set up a safety net',
    why,
    steps: [
      'Before changing anything, write a few UI flows (Maestro is the quickest: maestro.mobile.dev): launch, sign-in with a test account, and every tab or main screen.',
      'Keep test credentials in environment variables, never in the repo. Never let a flow press a button that writes to production (sign-up, purchase, posting).',
      'Assert that no error banner or red screen appears, not only that the app is running: a native module that fails to load can leave the process alive behind a red screen.',
      'Run the flows on both platforms on the current version, then again at the end of every phase below.',
    ],
  };
}

// Package families that must share a major version: updating one alone crashes at runtime.
const FAMILIES = [
  { re: /^@react-navigation\//, label: 'React Navigation' },
  { re: /^@react-native-firebase\//, label: 'React Native Firebase' },
];
function bumpSteps(list, extra = () => '') {
  const steps = [];
  const done = new Set();
  for (const d of list) {
    if (done.has(d.name)) continue;
    const fam = FAMILIES.find((f) => f.re.test(d.name));
    const members = fam ? list.filter((x) => fam.re.test(x.name)) : [];
    if (members.length > 1) {
      for (const m of members) done.add(m.name);
      steps.push(`${fam.label}, all together in one change (mixed majors crash at runtime): ${members.map((m) => `\`${m.name}\` ${m.from} → ${m.to}${extra(m)}`).join(', ')}.`);
    } else {
      done.add(d.name);
      steps.push(`\`${d.name}\` ${d.from} → ${d.to}${extra(d)}`);
    }
  }
  return steps;
}

export function buildPlan(result) {
  const isExpo = !!result.project.expo;
  const basePm = commands[packageManager(result.project.root)];
  // In Expo projects `npx expo install` picks the version that matches the SDK.
  const pm = isExpo ? { ...basePm, add: 'npx expo install' } : basePm;
  const pinned = isExpo ? expoPinnedNames(result.project.root) : new Set();
  const movesWithExpo = (name) => isExpo && movesWithExpoSdk(name, pinned);
  // Packages the React Native upgrade steps move (React Native itself and the compatibility tables).
  const movesWithRn = (name) => !isExpo && !!byKind('upgrade-rn').length && (name === 'react-native' || !!COMPAT[name]);
  const installed = new Set(result.deps.map((d) => d.name));
  const byKind = (kind) => result.findings.filter((f) => f.fix && f.fix.kind === kind).map((f) => f.fix);
  const phases = [];

  const secrets = byKind('secret');
  if (secrets.length) {
    const steps = [];
    for (const s of secrets.filter((x) => x.bundled)) {
      if (/^\.env/.test(s.file)) {
        steps.push(`**Rotate the secret values in \`${s.file}\`.** They are compiled into the JavaScript bundle, so every installed copy of the app contains them.`);
      } else {
        steps.push(`**Revoke the ${s.label}** in \`${s.file}:${s.line}\` at the provider today. Removing it from code is not enough: every installed copy of the app still contains it.`);
      }
    }
    if (secrets.some((x) => x.bundled)) {
      steps.push('Move every call that needs a secret behind your own backend (a Cloud Function, API route or edge function). The app should only hold keys that are designed to be public.');
    }
    for (const s of secrets.filter((x) => !x.bundled)) {
      if (s.label === 'Signing passwords') {
        steps.push(`**Move the signing passwords out of \`${s.file}\`** into \`~/.gradle/gradle.properties\` or CI environment variables; change them if the keystore ever left your control.`);
      } else {
        steps.push(`**Rotate the ${s.label}** in \`${s.file}\`, then load it from environment variables or a secret manager and add the file to \`.gitignore\`.`);
      }
    }
    steps.push('The old values stay in git history. Rotation is what makes them useless; rewriting history (e.g. `git filter-repo`) is optional cleanup.');
    phases.push({ title: 'Stop the leaks', why: 'Leaked keys cost money and data from the moment someone finds them. Nothing else in this plan is as urgent.', steps });
  }

  const sdk = byKind('target-sdk')[0];
  if (sdk) {
    phases.push({
      title: 'Meet the Google Play target SDK',
      why: 'Below the required level Google Play rejects updates or hides the app from new users.',
      steps: [
        `Set \`targetSdkVersion = ${sdk.to}\` and \`compileSdkVersion = ${sdk.to}\` in \`android/build.gradle\`.`,
        `Read the Android behavior changes for every API level between ${sdk.from} and ${sdk.to}; edge-to-edge display and foreground service types are the usual surprises.`,
        'Build a release bundle and test on a device running the newest Android version.',
      ],
    });
  }

  // Low-severity notes stay in the report; the plan only carries what can break the app.
  const crashes = byKind('crash');
  if (crashes.length) {
    phases.push({
      title: 'Fix crash risks',
      why: 'These setups build fine and crash at runtime. They are cheap to fix and every later step is easier to test without them.',
      steps: crashes.map((c) => c.step),
    });
  }

  const known = byKind('known-issue').filter((k) => k.severity !== 'low');
  if (known.length) {
    phases.push({
      title: 'Avoid known traps',
      why: 'These exact version combinations broke real apps. Handle them before the step that would trigger them.',
      steps: known.map((k) => `**${k.title}.** ${k.detail}`),
    });
  }

  const unusedDeps = byKind('remove-dep');
  if (unusedDeps.length) {
    phases.push({
      title: 'Remove unused packages',
      why: 'Every package you delete is one you never have to upgrade. Native modules also cut build time.',
      steps: [
        `\`${pm.remove} ${unusedDeps.map((d) => d.name).join(' ')}\`${unusedDeps.some((d) => d.native) ? ', then reinstall pods' : ''}.`,
        'Search the code once more for each name before removing it (dynamic requires are invisible to static analysis), then build both platforms.',
      ],
    });
  }

  const storeSteps = [];
  const privacy = byKind('privacy-manifest')[0];
  if (privacy && privacy.generated) {
    storeSteps.push('Run `pod install`, commit the generated `PrivacyInfo.xcprivacy`, and add your collected data types and tracking to it (React Native only fills in the required-reason APIs).');
  } else if (privacy) {
    storeSteps.push('Add `PrivacyInfo.xcprivacy` to the iOS app target. Start from the file in the React Native template and declare the required-reason APIs your app and SDKs use (UserDefaults, file timestamps, system boot time, disk space).');
  }
  const min16k = byKind('upgrade-rn-min')[0];
  const when16k = min16k && min16k.blocked ? 'Google Play rejects updates until' : `From ${min16k ? min16k.blockedFrom : ''} Google Play rejects updates until`;
  const by16k = min16k && min16k.blocked ? 'before your next Play release' : `before ${min16k ? min16k.blockedFrom : ''}`;
  if (min16k) {
    storeSteps.push(isExpo
      ? `**16 KB memory pages:** ${when16k} the app is on Expo SDK 53 (React Native 0.79) or later. The Expo SDK phase below gets you there; reach SDK 53 ${by16k}.`
      : `**16 KB memory pages:** ${when16k} the app is on React Native 0.77 or later. The React Native phase below gets you there; reach 0.77 ${by16k}.`);
  }
  const align = byKind('align-16kb')[0];
  if (align) {
    storeSteps.push(`Fix 16 KB alignment for ${align.libs.map((l) => `\`${l}\``).join(', ')}: find which package ships each library (\`grep -rl <lib> node_modules/*/android\`) and update it; libraries you build yourself need NDK r28+.`);
  }
  if (storeSteps.length) {
    phases.push({
      title: 'Meet App Store and Google Play requirements',
      why: 'These block your next store submission regardless of anything else in this plan.',
      steps: storeSteps,
    });
  }

  // Security steps, most severe first (they feed "Start here").
  const sevRank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const sec = [];
  for (const f of result.findings) {
    if (!f.fix) continue;
    const sev = sevRank[f.severity] ?? 4;
    if (f.fix.kind === 'manifest') {
      sec.push({ sev, step: f.fix.attr === 'android:debuggable' ? 'Remove `android:debuggable="true"` from `android/app/src/main/AndroidManifest.xml`.' : 'Move `android:usesCleartextTraffic="true"` to `android/app/src/debug/AndroidManifest.xml`, or allow only specific hosts with a network security config.' });
    } else if (f.fix.kind === 'ats') {
      sec.push({ sev, step: `In \`${f.fix.file}\`, set \`NSAllowsArbitraryLoads\` to false and list only the hosts that need HTTP under \`NSExceptionDomains\`.` });
    } else if (f.fix.kind === 'security') {
      // Hermes gets its own, more detailed step under legacy tooling.
      const step = byKind('enable-hermes').length ? f.fix.step.replace('Turn on Hermes. ', '') : f.fix.step;
      sec.push({ sev, step });
    } else if (f.fix.kind === 'vuln-dep' && (f.fix.severity === 'critical' || f.fix.severity === 'high')) {
      const v = f.fix;
      if (v.noFix) sec.push({ sev, step: `\`${v.name}\` ${v.from} has ${v.severity} known vulnerabilities and no fixed release (the latest is ${v.latest}): replace it, or make sure it never handles untrusted input.` });
      else sec.push({ sev, step: `Update \`${v.name}\` ${v.from}${v.to ? ` to ${v.to}${v.to.startsWith('a release') ? '' : ' or later'}` : ''}: it has ${v.severity} known vulnerabilities. ${movesWithExpo(v.name) ? 'Expo pins it: the SDK upgrade below moves it.' : movesWithRn(v.name) ? 'The React Native steps below move it past this version; if you ship before them, update it now.' : 'Check its changelog for breaking changes.'}` });
    }
  }
  const securitySteps = sec.sort((a, b) => a.sev - b.sev).map((x) => x.step);
  const minorVulns = byKind('vuln-dep').filter((v) => v.severity !== 'critical' && v.severity !== 'high').length;
  if (minorVulns) securitySteps.push(`${minorVulns} more package${minorVulns === 1 ? ' has' : 's have'} moderate or low advisories: update them with the routine package updates below.`);
  if (securitySteps.length) {
    phases.push({ title: 'Close security gaps', why: 'Attackers read app bundles, network traffic and logs. These are the ways in this app hands them something.', steps: securitySteps });
  }

  const cleanup = [];
  for (const f of byKind('default-react-host')) {
    cleanup.push(`When moving to React Native 0.80+, change \`DefaultReactHost.getDefaultReactHost(context, host)\` in \`${f.file}\` to pass \`null\` as a third argument.`);
  }
  for (const f of byKind('folly-flags')) {
    cleanup.push(`In \`${f.file}\`, add \`-DFOLLY_CFG_NO_COROUTINES=1\` and \`-DFOLLY_HAVE_CLOCK_GETTIME=1\` to OTHER_CPLUSPLUSFLAGS (Debug and Release) before moving to React Native 0.80.`);
  }
  for (const p of byKind('patch-artifacts')) {
    cleanup.push(`Recreate \`patches/${p.file}\` without build output: reinstall \`${p.pkg}\`, re-apply the source edits, then \`npx patch-package ${p.pkg} --exclude '(^package\\.json$|/build/)'\`.`);
  }
  for (const p of byKind('patch-version')) {
    cleanup.push(`\`patches/${p.file}\` targets ${p.pkg} ${p.version} but ${p.installed} is installed: check whether the fix is still needed, then recreate or delete it.`);
  }
  for (const d of byKind('deprecated-core')) cleanup.push(d.step);
  if (byKind('podfile-cli-require').length) {
    cleanup.push("Delete `require_relative '../node_modules/@react-native-community/cli-platform-ios/native_modules'` from `ios/Podfile`; `use_native_modules!` comes from React Native.");
  }
  if (byKind('remove-flipper').length) {
    cleanup.push('Remove Flipper: delete the `com.facebook.flipper` dependencies and `FLIPPER_VERSION` on Android, `use_flipper!` / Flipper config in the Podfile, and the `ReactNativeFlipper` initialization code. Use React Native DevTools instead.');
  }
  const hermes = byKind('enable-hermes')[0];
  if (hermes) {
    const where = (hermes.platforms || ['android', 'ios']).map((pl) => (pl === 'android' ? 'set `hermesEnabled=true` in `android/gradle.properties`' : 'set `:hermes_enabled => true` in the Podfile'));
    cleanup.push(`Switch to Hermes: ${where.join(' and ')}, then test anything that relied on JavaScriptCore behavior (Intl, Date parsing).`);
  }
  if (cleanup.length) {
    phases.push({ title: 'Remove legacy tooling', why: 'Leftovers from older templates break on newer React Native versions; removing them first shrinks the upgrade diff.', steps: cleanup });
  }

  const allReplace = byKind('replace-dep');
  // Abandoned pure-JS packages do not block an upgrade; they get their own, later phase.
  const jsAbandoned = allReplace.filter((d) => !d.native && !d.noNewArch);
  const interopPatched = new Set(byKind('interop-job').map((j) => j.name));
  const replace = allReplace.filter((d) => d.native || d.noNewArch).sort((a, b) => Number(b.noNewArch) - Number(a.noNewArch) || Number(b.native) - Number(a.native));
  if (replace.length) {
    phases.push({
      title: 'Replace blocking and abandoned packages',
      why: 'These packages decide how far you can upgrade. Swap them while the app still runs on its current version, so every problem has one cause.',
      steps: replace.map((d) => {
        const reason = [d.noNewArch && 'no New Architecture support', d.unmaintained && 'unmaintained'].filter(Boolean).join(', ');
        if (d.renamedTo) {
          return `\`${d.name}\` moved to \`${d.renamedTo}\` (same API). \`${pm.remove} ${d.name} && ${pm.add} ${d.renamedTo}\`, then update the imports.`;
        }
        if (interopPatched.has(d.name) && !d.unmaintained) {
          return `\`${d.name}\` (${reason}, native). The New Architecture step below patches it so it loads; move to a release with a TurboModule spec once one exists.`;
        }
        const owned = d.alternatives.find((a) => installed.has(a));
        if (owned) {
          return `\`${d.name}\` (${reason}${d.native ? ', native' : ''}). You already use \`${owned}\`: move the remaining usage there, then \`${pm.remove} ${d.name}\`.`;
        }
        // expo-* packages need Expo modules; a bare app without them should get another option first.
        const usesExpoModules = isExpo || installed.has('expo');
        const to = usesExpoModules ? d.alternatives[0] : d.alternatives.find((a) => !a.startsWith('expo-')) || d.alternatives[0];
        const needsExpo = to && to.startsWith('expo-') && !usesExpoModules ? ' (Expo packages need Expo modules first: `npx install-expo-modules@latest`)' : '';
        const cmd = to ? ` \`${pm.remove} ${d.name} && ${pm.add} ${to}\`${needsExpo}` : '';
        const options = d.alternatives.length
          ? `Options: ${d.alternatives.map((a) => `\`${a}\``).join(', ')}.${cmd}`
          : d.noNewArch
            ? 'No known replacement: check for a maintained fork, or vendor and patch it with `patch-package`.'
            : 'Not a known blocker: keep it while it builds and passes your UI flows at every step below, and replace it (or patch it with `patch-package`) when it breaks.';
        return `\`${d.name}\` (${reason}${d.native ? ', native' : ''}). ${options}`;
      }),
    });
  }

  const expoMoves = byKind('bump-dep').filter((d) => movesWithExpo(d.name));
  // Libraries with a compatibility table: only as far as the current React Native supports.
  // The React Native steps move them further.
  const curMinor = result.project.reactNative ? Number(result.project.reactNative.split('.')[1]) : null;
  const archNow = !byKind('enable-new-arch').length;
  const rnTarget = byKind('upgrade-rn')[0];
  const rnBehind = !!(rnTarget && curMinor !== null && Number(rnTarget.to.split('.')[1]) - curMinor >= 3);
  const nativeBumps = byKind('bump-dep')
    .filter((d) => d.native && !movesWithExpo(d.name))
    .map((d) => {
      if (!COMPAT[d.name] || curMinor === null) return d;
      const best = bestRange(d.name, curMinor, archNow);
      if (!best) return null; // the table starts later: the React Native steps move it
      if (compareVersions(d.from, best.from) >= 0 && (!best.to || compareVersions(d.from, best.to) <= 0)) return null;
      if (compareVersions(d.from, best.from) > 0) return null;
      return { ...d, to: best.range, capped: `0.${curMinor}` };
    })
    .filter(Boolean)
    // Far behind: the latest release usually needs a newer React Native than the app has.
    .map((d) => (rnBehind && !d.capped ? { ...d, to: `the newest release that supports React Native 0.${curMinor} (latest is ${d.to})` } : d));
  if (nativeBumps.length) {
    phases.push({
      title: 'Update native modules on the current React Native version',
      why: 'Newer releases of native modules usually add New Architecture support. Pick the newest release that still supports your current React Native version; check each changelog for its minimum.',
      steps: bumpSteps(nativeBumps, (d) => (d.capped ? ` (the newest for React Native ${d.capped}; later versions come with the React Native steps below)` : '')),
    });
  }

  const depProvider = byKind('app-dependency-provider')[0];
  const arch = byKind('enable-new-arch')[0];
  if (depProvider && !arch) {
    phases.push({
      title: 'Fix the iOS AppDelegate',
      why: 'With the New Architecture on, this is a launch crash in Release builds.',
      steps: [`In \`${depProvider.file}\`: \`#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>\` and \`self.dependencyProvider = [RCTAppDependencyProvider new];\` before \`[super application:didFinishLaunchingWithOptions:]\`.`],
    });
  }
  let deferredArch = null;
  if (arch) {
    const steps = [];
    for (const j of byKind('interop-job')) {
      steps.push(`Patch \`${j.name}\` with patch-package so its ${j.methods.length} Kotlin @ReactMethods return Unit instead of a coroutine Job (wrap \`scope.launch { }\` in a helper that returns Unit and rename \`return@launch\` labels). Otherwise the module fails to load on Android.`);
    }
    if (depProvider) {
      steps.push(`In \`${depProvider.file}\`, add \`#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>\` and \`self.dependencyProvider = [RCTAppDependencyProvider new];\` before calling super. Without it the switch causes a launch crash in Release.`);
    }
    if (result.project.managed) {
      steps.push('Set `"newArchEnabled": true` in `app.json` (under `expo`), then make a new development build (`eas build --profile development`, or `npx expo run:ios` / `npx expo run:android`). Expo Go cannot test this switch.');
    } else {
      if (arch.platforms.includes('android')) steps.push('Android: set `newArchEnabled=true` in `android/gradle.properties`.');
      if (arch.platforms.includes('ios')) steps.push('iOS: set `"newArchEnabled": "true"` in `ios/Podfile.properties.json` (or run `RCT_NEW_ARCH_ENABLED=1 bundle exec pod install`).');
    }
    for (const c of byKind('compat').filter((x) => x.forNewArch && x.range)) {
      steps.unshift(`First move \`${c.name}\` to ${c.range}: the installed version does not support the New Architecture on this React Native version.`);
    }
    if (!result.project.managed) {
      steps.push('Clean everything (`./gradlew clean`, `watchman watch-del-all`, delete `ios/build` and `ios/Pods`). Switching architecture without a clean build fails on stale codegen output (e.g. missing `Native…Spec` classes).');
    }
    steps.push(result.project.managed ? 'Build a development and a production build for both platforms.' : 'Build debug and release on both platforms.');
    steps.push('Click through every screen that uses a native module. Interop-layer problems show up at runtime, not at build time.');
    // Before 0.76 the New Architecture is too immature to switch on in place: do it on the way,
    // at the first stop between 0.76 and 0.81 (or Expo SDK 52+), in its own commit.
    const currentMinor = Number((result.project.reactNative || '0.99').split('.')[1]);
    if (currentMinor < 76) {
      deferredArch = steps;
    } else {
      phases.push({
        title: 'Turn on the New Architecture on your current version',
        why: `React Native 0.${NEW_ARCH_ONLY_MINOR} removed the legacy architecture. Switching now, before changing the React Native version, keeps the two kinds of breakage apart.`,
        steps,
      });
    }
  }

  const rn = byKind('upgrade-rn')[0];
  if (rn) {
    let from = rn.from;
    const tracked = result.deps.filter((d) => COMPAT[d.name]);
    const lastRange = {};
    const lastMajor = {};
    const hopList = upgradeHops(rn.from, rn.to);
    // When the New Architecture switch happens on the way, library versions up to that stop
    // must still run on the legacy architecture (Reanimated 4, for one, does not).
    const switchAt = deferredArch
      ? hopList.findIndex((h) => Number(h.split('.')[1]) >= 76 && Number(h.split('.')[1]) < NEW_ARCH_ONLY_MINOR)
      : -1;
    const majorOf = (v) => Number(String(v).split('.')[0]);
    const steps = hopList.map((to, i) => {
      const minor = Number(to.split('.')[1]);
      const archOn = switchAt < 0 || i > switchAt;
      const bumps = tracked
        .map((d) => {
          const best = bestRange(d.name, minor, archOn);
          // Stay on the major of the previous step (or the installed one) while it still works.
          const major = lastMajor[d.name] ?? (d.version ? majorOf(d.version) : null);
          const same = major !== null && best && majorOf(best.from) !== major ? bestRange(d.name, minor, archOn, { major }) : null;
          return { name: d.name, best, same };
        })
        .filter((b) => b.best && (b.same || b.best).range !== lastRange[b.name])
        .map((b) => {
          const chosen = b.same || b.best;
          const forcedMajor = !b.same && lastMajor[b.name] !== undefined && majorOf(chosen.from) !== lastMajor[b.name];
          lastRange[b.name] = chosen.range;
          lastMajor[b.name] = majorOf(chosen.from);
          if (b.same) return `\`${b.name}\` ${b.same.range} (or ${b.best.range}, a major migration)`;
          return `\`${b.name}\` ${b.best.range}${forcedMajor ? ' (a major migration: read its migration guide first)' : ''}`;
        });
      const step = `${from} → ${to}: apply the diff from ${UPGRADE_HELPER_URL(from, to)}${bumps.length ? `, move ${bumps.join(' and ')}` : ''}, reinstall pods, build both platforms, commit.`;
      from = to;
      return step;
    });
    if (deferredArch) {
      const hops = upgradeHops(rn.from, rn.to);
      const at = hops.findIndex((h) => Number(h.split('.')[1]) >= 76 && Number(h.split('.')[1]) < NEW_ARCH_ONLY_MINOR);
      if (at >= 0) {
        steps.splice(
          at + 1,
          0,
          `**Stop at ${hops[at]} and turn on the New Architecture** before going further: 0.${NEW_ARCH_ONLY_MINOR} removed the legacy one. Do it in its own commit:`,
          ...deferredArch.map((x) => `New Architecture: ${x}`),
        );
        deferredArch = null;
      }
    }
    steps.push('Bump `react`, `@react-native/*` packages and the Metro/Babel config to the versions the Upgrade Helper shows for the target.');
    const patchesReview = byKind('patches-review')[0];
    if (patchesReview) {
      steps.push(`After every hop, re-check ${patchesReview.patches.map((x) => `\`patches/${x.file}\``).join(', ')}: still applies (\`npx patch-package\`), still needed, not undoing what the new version expects.`);
    }
    steps.push('If `pod install` reports that a React Native dependency (fast_float, hermes-engine, …) differs from Podfile.lock, delete `ios/Pods` and `ios/Podfile.lock` and install again; library pods keep the versions their podspecs pin.');
    steps.push('Update the Gradle version by editing `android/gradle/wrapper/gradle-wrapper.properties`: `./gradlew wrapper` fails because the new React Native Gradle plugin already needs the new Gradle.');
    phases.push({
      title: `Upgrade React Native ${rn.from} → ${rn.to}`,
      why: 'Hopping a few minors at a time gives small diffs you can actually review and bisect when something breaks.',
      steps,
    });
  }

  const expo = byKind('upgrade-expo')[0];
  if (expo) {
    const steps = [];
    if (expo.to - expo.from >= 6) {
      steps.push(`**${expo.to - expo.from} SDKs is a long way.** Weigh it against starting a fresh project on SDK ${expo.to} (\`npx create-expo-app\`) and moving your screens, assets and app config over: with few custom native modules that is often faster than ${expo.to - expo.from} upgrades.`);
    }
    for (let v = expo.from + 1; v <= expo.to; v++) {
      // The local Expo CLI (`npx expo`) exists from SDK 46; older SDKs upgrade with expo-cli.
      steps.push(
        v < 46
          ? `SDK ${v - 1} → ${v}: \`npx expo-cli upgrade ${v}\` (the legacy CLI; the local \`npx expo\` CLI arrives with SDK 46), read the SDK ${v} changelog, build.`
          : v === 46
            ? `SDK 45 → 46: \`${basePm.add} expo@^46.0.0\`, then \`npx expo install --fix\` (the first SDK with the local CLI), read the SDK 46 changelog, build.`
            : `SDK ${v - 1} → ${v}: \`npx expo install expo@^${v}.0.0 --fix\`, read the SDK ${v} changelog, run \`npx expo-doctor\`, build.`,
      );
      // SDK 52 ships React Native 0.76, the first version where switching is practical.
      if (deferredArch && v >= 52) {
        steps.push(`**At SDK ${v}, turn on the New Architecture** before going further (it is the default from SDK 53, and React Native 0.${NEW_ARCH_ONLY_MINOR} removed the legacy one):`, ...deferredArch.map((x) => `New Architecture: ${x}`));
        deferredArch = null;
      }
    }
    steps.push('Each SDK brings its own React Native version; do not upgrade React Native separately.');
    if (expoMoves.length) {
      const names = expoMoves.map((d) => `\`${d.name}\``);
      steps.push(`\`npx expo install --fix\` also moves ${names.slice(0, 8).join(', ')}${names.length > 8 ? ` and ${names.length - 8} more` : ''} to the versions each SDK expects. Do not bump them yourself: a newer major than the SDK supports fails to build.`);
    }
    if (!result.project.managed) {
      steps.push('This app has its own android/ and ios/ folders: after each SDK, apply the native changes from Expo\'s native project upgrade helper (docs.expo.dev/bare/upgrade), then `pod install` and build both platforms.');
    }
    phases.push({ title: `Upgrade Expo SDK ${expo.from} → ${expo.to}`, why: 'Expo only supports one SDK step at a time reliably.', steps });
  }

  if (jsAbandoned.length) {
    phases.push({
      title: 'Plan replacements for abandoned JavaScript packages',
      why: 'These do not block the upgrade (no native code), but nobody fixes their bugs any more. Replace them when you next touch that code.',
      steps: jsAbandoned.map((d) => {
        const owned = d.alternatives.find((a) => installed.has(a));
        if (owned) return `\`${d.name}\`: you already use \`${owned}\`; move the remaining usage there, then \`${pm.remove} ${d.name}\`.`;
        return `\`${d.name}\`${d.alternatives.length ? `: options ${d.alternatives.map((a) => `\`${a}\``).join(', ')}` : ': look for a maintained alternative, or keep it if it does what you need'}.`;
      }),
    });
  }

  const perf = byKind('performance');
  if (perf.length) {
    phases.push({
      title: 'Speed up the app',
      why: 'Static signs of jank and weight. Measure on a low-end Android device before and after: these are the usual suspects, not proof.',
      steps: perf.map((p) => p.step),
    });
  }

  const jsBumps = byKind('bump-dep').filter((d) => !d.native && !movesWithExpo(d.name));
  if (jsBumps.length) {
    phases.push({
      title: 'Update JavaScript-only packages',
      why: 'These do not block the upgrade. Do them last, one major at a time, following each migration guide.',
      steps: bumpSteps(jsBumps),
    });
  }

  const minimums = [...byKind('min-sdk').map((m) => `Android minSdk → ${m.to}`), ...byKind('ios-min').map((m) => `iOS deployment target → ${m.to}`)];
  if (minimums.length) {
    // Raise minimums right before the React Native upgrade that requires them.
    const at = phases.findIndex((p) => p.title.startsWith('Upgrade React Native'));
    phases.splice(at >= 0 ? at : phases.length, 0, {
      title: 'Raise platform minimums',
      why: 'Current React Native no longer supports older OS versions. Check your analytics for how many users this drops before you ship.',
      steps: minimums,
    });
  }

  // Store deadlines sit together, right after the target SDK.
  const storeAt = phases.findIndex((p) => p.title === 'Meet App Store and Google Play requirements');
  const targetAt = phases.findIndex((p) => p.title === 'Meet the Google Play target SDK');
  if (storeAt > targetAt + 1 && targetAt >= 0) phases.splice(targetAt + 1, 0, ...phases.splice(storeAt, 1));

  // Only worth it when the plan changes code: secrets alone do not need UI tests.
  const leaksFirst = phases[0] && phases[0].title === 'Stop the leaks' ? 1 : 0;
  if (phases.length > leaksFirst) {
    phases.splice(leaksFirst, 0, safetyNetPhase(existingUiTests(result.project.root, installed)));
  }

  phases.push({
    title: 'Verify before you ship',
    why: 'An upgrade is done when the release build works on real devices, not when it compiles.',
    steps: [
      result.project.managed
        ? 'Production builds on both platforms (`eas build --platform all --profile production`, or `npx expo run:android --variant release` and `npx expo run:ios --configuration Release`).'
        : 'Release builds on both platforms (`./gradlew bundleRelease`, Xcode Archive).',
      'Test on a low-end Android device and on the newest iOS and Android versions.',
      'Ship to internal testing / TestFlight first and watch crash-free sessions for a few days before a staged rollout.',
      'Run `npx nativekeel` again: the report should have no critical or high findings.',
    ],
  });

  return { phases, complexity: complexity(result.findings) };
}

export function planToMarkdown(result, plan) {
  const p = result.project;
  const lines = [
    `# ${plan.phases.some((ph) => /^Upgrade (React Native|Expo SDK)/.test(ph.title)) ? 'Upgrade plan' : 'Action plan'}: ${p.name || 'your app'}`,
    '',
    `Generated by NativeKeel on ${result.scannedAt.slice(0, 10)}.  `,
    `React Native ${p.reactNative || '-'}${p.expo ? ` · Expo ${p.expo}` : ''} → latest ${result.latest.reactNative || '-'}.  `,
    `Estimated scope: **${plan.complexity.size}** (score ${plan.complexity.score}).`,
    '',
  ];
  plan.phases.forEach((phase, i) => {
    lines.push(`## ${i + 1}. ${phase.title}`, '', `_${phase.why}_`, '');
    phase.steps.forEach((s) => lines.push(`- [ ] ${s}`));
    lines.push('');
  });
  lines.push('---', `No time to do it yourself? We do fixed-price upgrades on a branch of your repo: ${SITE_URL}/#services`);
  return `${lines.join('\n')}\n`;
}

// The first concrete step of the first few phases: what to do today. Shown at the top of the
// HTML report and under the summary in the terminal.
const URGENCY = ['Stop the leaks', 'Fix crash risks', 'Meet the Google Play target SDK', 'Meet App Store and Google Play requirements', 'Close security gaps', 'Avoid known traps'];

export function startHere(result, count = 3) {
  const skip = new Set(['Set up a safety net', 'Verify before you ship']);
  const rank = (t) => (URGENCY.indexOf(t) >= 0 ? URGENCY.indexOf(t) : URGENCY.length);
  return buildPlan(result)
    .phases.filter((p) => !skip.has(p.title) && p.steps.length)
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p.title) - rank(b.p.title) || a.i - b.i)
    .slice(0, count)
    .map(({ p }) => ({ phase: p.title, step: p.steps[0].replace(/ The [^.]* phase below gets you there;.*$/, '') }));
}
