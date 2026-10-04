import fs from 'node:fs';
import path from 'node:path';
import { UPGRADE_HELPER_URL, NEW_ARCH_ONLY_MINOR } from './rules.js';
import { SITE_URL } from './config.js';
import { COMPAT, bestRange } from './compat.js';

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
};

export function complexity(findings) {
  const score = Math.round(
    findings.reduce((sum, f) => sum + (f.fix && WEIGHTS[f.fix.kind] ? WEIGHTS[f.fix.kind](f.fix) : 0), 0),
  );
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

export function buildPlan(result) {
  const pm = commands[packageManager(result.project.root)];
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

  const known = byKind('known-issue');
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

  const securitySteps = [];
  for (const m of byKind('manifest')) {
    securitySteps.push(m.attr === 'android:debuggable'
      ? 'Remove `android:debuggable="true"` from `android/app/src/main/AndroidManifest.xml`.'
      : 'Move `android:usesCleartextTraffic="true"` to `android/app/src/debug/AndroidManifest.xml`, or allow only specific hosts with a network security config.');
  }
  for (const a of byKind('ats')) {
    securitySteps.push(`In \`${a.file}\`, set \`NSAllowsArbitraryLoads\` to false and list only the hosts that need HTTP under \`NSExceptionDomains\`.`);
  }
  if (securitySteps.length) {
    phases.push({ title: 'Tighten transport security', why: 'Unencrypted traffic exposes user data on public networks.', steps: securitySteps });
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
  if (byKind('podfile-cli-require').length) {
    cleanup.push("Delete `require_relative '../node_modules/@react-native-community/cli-platform-ios/native_modules'` from `ios/Podfile`; `use_native_modules!` comes from React Native.");
  }
  if (byKind('remove-flipper').length) {
    cleanup.push('Remove Flipper: delete the `com.facebook.flipper` dependencies and `FLIPPER_VERSION` on Android, `use_flipper!` / Flipper config in the Podfile, and the `ReactNativeFlipper` initialization code. Use React Native DevTools instead.');
  }
  if (byKind('enable-hermes').length) {
    cleanup.push('Switch to Hermes: set `hermesEnabled=true` in `android/gradle.properties` and `:hermes_enabled => true` in the Podfile, then test anything that relied on JavaScriptCore behavior (Intl, Date parsing).');
  }
  if (cleanup.length) {
    phases.push({ title: 'Remove legacy tooling', why: 'Leftovers from older templates break on newer React Native versions; removing them first shrinks the upgrade diff.', steps: cleanup });
  }

  const replace = byKind('replace-dep').sort((a, b) => Number(b.noNewArch) - Number(a.noNewArch) || Number(b.native) - Number(a.native));
  if (replace.length) {
    phases.push({
      title: 'Replace blocking and abandoned packages',
      why: 'These packages decide how far you can upgrade. Swap them while the app still runs on its current version, so every problem has one cause.',
      steps: replace.map((d) => {
        const reason = [d.noNewArch && 'no New Architecture support', d.unmaintained && 'unmaintained'].filter(Boolean).join(', ');
        const owned = d.alternatives.find((a) => installed.has(a));
        if (owned) {
          return `\`${d.name}\` (${reason}${d.native ? ', native' : ''}). You already use \`${owned}\`: move the remaining usage there, then \`${pm.remove} ${d.name}\`.`;
        }
        const to = d.alternatives[0];
        const cmd = to ? ` \`${pm.remove} ${d.name} && ${pm.add} ${to}\`` : '';
        const options = d.alternatives.length ? `Options: ${d.alternatives.map((a) => `\`${a}\``).join(', ')}.${cmd}` : 'No known replacement: check for a maintained fork, or vendor and patch it with `patch-package`.';
        return `\`${d.name}\` (${reason}${d.native ? ', native' : ''}). ${options}`;
      }),
    });
  }

  const nativeBumps = byKind('bump-dep').filter((d) => d.native);
  if (nativeBumps.length) {
    phases.push({
      title: 'Update native modules on the current React Native version',
      why: 'Newer releases of native modules usually add New Architecture support. Pick the newest release that still supports your current React Native version; check each changelog for its minimum.',
      steps: nativeBumps.map((d) => `\`${d.name}\` ${d.from} → ${d.to}`),
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
  if (arch) {
    const steps = [];
    for (const j of byKind('interop-job')) {
      steps.push(`Patch \`${j.name}\` with patch-package so its ${j.methods.length} Kotlin @ReactMethods return Unit instead of a coroutine Job (wrap \`scope.launch { }\` in a helper that returns Unit and rename \`return@launch\` labels). Otherwise the module fails to load on Android.`);
    }
    if (depProvider) {
      steps.push(`In \`${depProvider.file}\`, add \`#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>\` and \`self.dependencyProvider = [RCTAppDependencyProvider new];\` before calling super. Without it the switch causes a launch crash in Release.`);
    }
    if (result.project.managed) {
      steps.push('Set `"newArchEnabled": true` in `app.json` (under `expo`), then run `npx expo prebuild --clean` and build.');
    } else {
      if (arch.platforms.includes('android')) steps.push('Android: set `newArchEnabled=true` in `android/gradle.properties`.');
      if (arch.platforms.includes('ios')) steps.push('iOS: set `"newArchEnabled": "true"` in `ios/Podfile.properties.json` (or run `RCT_NEW_ARCH_ENABLED=1 bundle exec pod install`).');
    }
    for (const c of byKind('compat').filter((x) => x.forNewArch && x.range)) {
      steps.unshift(`First move \`${c.name}\` to ${c.range}: the installed version does not support the New Architecture on this React Native version.`);
    }
    steps.push('Clean everything (`./gradlew clean`, `watchman watch-del-all`, delete `ios/build` and `ios/Pods`). Switching architecture without a clean build fails on stale codegen output (e.g. missing `Native…Spec` classes).');
    steps.push('Build debug and release on both platforms.');
    steps.push('Click through every screen that uses a native module. Interop-layer problems show up at runtime, not at build time.');
    phases.push({
      title: 'Turn on the New Architecture on your current version',
      why: `React Native 0.${NEW_ARCH_ONLY_MINOR} removed the legacy architecture. Switching now, before changing the React Native version, keeps the two kinds of breakage apart.`,
      steps,
    });
  }

  const rn = byKind('upgrade-rn')[0];
  if (rn) {
    let from = rn.from;
    const tracked = result.deps.filter((d) => COMPAT[d.name]);
    const lastRange = {};
    const steps = upgradeHops(rn.from, rn.to).map((to) => {
      const minor = Number(to.split('.')[1]);
      const bumps = tracked
        .map((d) => {
          const best = bestRange(d.name, minor, true);
          // Prefer staying on the installed major when it still supports this hop.
          const major = d.version ? Number(d.version.split('.')[0]) : null;
          const same = major !== null && best && Number(best.from.split('.')[0]) !== major ? bestRange(d.name, minor, true, { major }) : null;
          return { name: d.name, best, same };
        })
        .filter((b) => b.best && (b.same || b.best).range !== lastRange[b.name])
        .map((b) => {
          lastRange[b.name] = (b.same || b.best).range;
          return b.same ? `\`${b.name}\` ${b.same.range} (or ${b.best.range}, a major migration)` : `\`${b.name}\` ${b.best.range}`;
        });
      const step = `${from} → ${to}: apply the diff from ${UPGRADE_HELPER_URL(from, to)}${bumps.length ? `, move ${bumps.join(' and ')}` : ''}, reinstall pods, build both platforms, commit.`;
      from = to;
      return step;
    });
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
    for (let v = expo.from + 1; v <= expo.to; v++) steps.push(`SDK ${v - 1} → ${v}: \`npx expo install expo@^${v}.0.0 --fix\`, read the SDK ${v} changelog, run \`npx expo-doctor\`, build.`);
    steps.push('Each SDK brings its own React Native version; do not upgrade React Native separately.');
    if (!result.project.managed) {
      steps.push('This app has its own android/ and ios/ folders: after each SDK, apply the native changes from Expo\'s native project upgrade helper (docs.expo.dev/bare/upgrade), then `pod install` and build both platforms.');
    }
    phases.push({ title: `Upgrade Expo SDK ${expo.from} → ${expo.to}`, why: 'Expo only supports one SDK step at a time reliably.', steps });
  }

  const jsBumps = byKind('bump-dep').filter((d) => !d.native);
  if (jsBumps.length) {
    phases.push({
      title: 'Update JavaScript-only packages',
      why: 'These do not block the upgrade. Do them last, one major at a time, following each migration guide.',
      steps: jsBumps.map((d) => `\`${d.name}\` ${d.from} → ${d.to}`),
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

  // Only worth it when the plan changes code: secrets alone do not need UI tests.
  const leaksFirst = phases[0] && phases[0].title === 'Stop the leaks' ? 1 : 0;
  if (phases.length > leaksFirst) {
    phases.splice(leaksFirst, 0, safetyNetPhase(existingUiTests(result.project.root, installed)));
  }

  phases.push({
    title: 'Verify before you ship',
    why: 'An upgrade is done when the release build works on real devices, not when it compiles.',
    steps: [
      'Release builds on both platforms (`./gradlew bundleRelease`, Xcode Archive).',
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
    `# Upgrade plan: ${p.name || 'your app'}`,
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
