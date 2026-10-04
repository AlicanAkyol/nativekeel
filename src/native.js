import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkArchive, findBuiltArtifact } from './elf-align.js';
import { PAGE_SIZE_16K, PLATFORM_MINIMUMS } from './rules.js';
import { installedVersion as installedVersionOf } from './project.js';

// Checks on native project files: store requirements and security settings that live
// outside package.json. Every check returns findings in the same shape as analyze.js.

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

function findFiles(dir, test, depth = 0, out = []) {
  if (depth > 4) return out;
  let list;
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of list) {
    if (['Pods', 'build', 'node_modules', '.git', 'DerivedData'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(full, test, depth + 1, out);
    else if (test(e.name, full)) out.push(full);
  }
  return out;
}

const minorOf = (v) => (v ? Number(v.split('.')[1]) : null);

function gitTracked(root) {
  const res = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) return null;
  // ls-files paths are relative to the current directory, which is the app root here.
  return res.stdout.split('\n').filter(Boolean);
}

// Debug-only native libraries that never ship in a release build.
const DEBUG_ONLY_LIBS = /\/lib(flipper|event(_core|_extra)?-[\d.]+|fbjni_debug)\.so$/;

export function nativeChecks(project, { rnLatest = null, now = new Date() } = {}) {
  const today = now.toISOString().slice(0, 10);
  const findings = [];
  const add = (f) => findings.push(f);
  const root = project.root;
  const rn = minorOf(project.rnVersion);
  const hasIos = fs.existsSync(path.join(root, 'ios'));
  const hasAndroid = fs.existsSync(path.join(root, 'android'));

  // 16 KB page size: React Native itself before 0.77, then the actual built binaries.
  if (hasAndroid || project.managed) {
    if (rn !== null && rn < PAGE_SIZE_16K.firstRnMinor && today >= PAGE_SIZE_16K.since) {
      add({
        id: 'android-16kb-rn',
        severity: 'critical',
        area: 'store',
        title: `React Native ${project.rnVersion} does not support 16 KB memory pages`,
        detail: `Google Play rejects updates without 16 KB page support since ${PAGE_SIZE_16K.since} (extensions ended ${PAGE_SIZE_16K.extensionUntil}). React Native supports it from 0.${PAGE_SIZE_16K.firstRnMinor}${project.expoVersion ? ', which in Expo means SDK 53 or later (SDK 52 ships React Native 0.76)' : ''}.`,
        fix: { kind: 'upgrade-rn-min', to: `0.${PAGE_SIZE_16K.firstRnMinor}.0` },
      });
    }
    const artifact = findBuiltArtifact(root);
    if (artifact) {
      let result = null;
      try {
        result = checkArchive(artifact);
      } catch {
        result = null;
      }
      if (result) {
        const isRelease = /release/i.test(artifact);
        const relevant = result.misaligned.filter((l) => isRelease || !DEBUG_ONLY_LIBS.test(l.path));
        const rel = path.relative(root, artifact);
        const libs = [...new Set(relevant.map((l) => path.basename(l.path)))];
        if (relevant.length) {
          add({
            id: 'android-16kb-libs',
            severity: isRelease ? 'critical' : 'high',
            area: 'store',
            title: `${libs.length} native librar${libs.length === 1 ? 'y is' : 'ies are'} not 16 KB aligned (${rel})`,
            detail: `${libs.slice(0, 6).join(', ')}${libs.length > 6 ? ', …' : ''}. Google Play rejects updates containing them. Update the package that ships each library, or rebuild it with NDK r28+.`,
            fix: { kind: 'align-16kb', libs },
          });
        } else {
          const ignored = result.misaligned.length;
          add({
            id: 'android-16kb-ok',
            severity: 'info',
            area: 'store',
            title: ignored
              ? `${result.libs.length - ignored} of ${result.libs.length} 64-bit native libraries are 16 KB aligned; the other ${ignored} are debug-only`
              : `All ${result.libs.length} 64-bit native libraries are 16 KB aligned`,
            detail: `Checked ${rel}.${ignored ? ' Debug-only libraries (e.g. Flipper) never ship, but build a release bundle and re-run to be certain.' : ''}`,
          });
        }
      }
    }
  }

  // RCTAppDependencyProvider: required in AppDelegate since React Native 0.77. Without it,
  // third-party Fabric components fall back to the legacy interop layer and send
  // RCTEventEmitter events, which do not exist in bridgeless mode: an error in Debug and a
  // launch crash in Release (seen as an App Review rejection).
  if (hasIos && rn !== null && rn >= 77) {
    const delegates = findFiles(path.join(root, 'ios'), (name) => /^AppDelegate\.(mm|m|swift)$/.test(name));
    const sources = delegates.map((f) => ({ f, text: read(f) || '' }));
    const usesRnDelegate = sources.some(({ text }) => /RCTAppDelegate|RCTReactNativeFactory|RCTDefaultReactNativeFactoryDelegate/.test(text)) ||
      findFiles(path.join(root, 'ios'), (name) => name === 'AppDelegate.h').some((f) => /RCTAppDelegate/.test(read(f) || ''));
    const hasProvider = sources.some(({ text }) => /RCTAppDependencyProvider/.test(text));
    if (delegates.length && usesRnDelegate && !hasProvider) {
      const archOn = project.newArch.ios !== false;
      add({
        id: 'ios-app-dependency-provider',
        severity: archOn ? 'critical' : 'high',
        area: 'native',
        title: `iOS AppDelegate is missing RCTAppDependencyProvider (${path.relative(root, delegates[0])})`,
        detail: `Required since React Native 0.77. Without it, library Fabric components fall back to the legacy interop layer and send RCTEventEmitter events, which are not registered with the New Architecture: "RCTEventEmitter.receiveEvent() ... has not been registered as callable", logged in Debug, a launch crash in Release.${archOn ? '' : ' It will surface as soon as the New Architecture is turned on.'} Add the import and \`self.dependencyProvider = [RCTAppDependencyProvider new];\` before calling super.`,
        fix: { kind: 'app-dependency-provider', file: path.relative(root, delegates[0]) },
      });
    }
  }

  // Flipper was removed from the React Native template in 0.74.
  const appGradle = read(path.join(root, 'android', 'app', 'build.gradle')) || read(path.join(root, 'android', 'app', 'build.gradle.kts')) || '';
  const gradleProps = read(path.join(root, 'android', 'gradle.properties')) || '';
  const podfile = read(path.join(root, 'ios', 'Podfile')) || '';
  const flipperWired = /com\.facebook\.flipper/.test(appGradle) || /^\s*[^#\n]*(use_flipper!|FlipperConfiguration\.enabled)/m.test(podfile);
  if (flipperWired) {
    add({
      id: 'flipper',
      severity: 'medium',
      area: 'native',
      title: 'Flipper is still integrated',
      detail: 'Flipper was removed from React Native in 0.74 and its native libraries are not 16 KB aligned. Remove the Flipper dependencies and initialization code before upgrading; use React Native DevTools instead.',
      fix: { kind: 'remove-flipper' },
    });
  } else if (/^\s*FLIPPER_VERSION\s*=/m.test(gradleProps)) {
    // A leftover property from an old template: harmless, but worth deleting.
    add({
      id: 'flipper-leftover',
      severity: 'low',
      area: 'native',
      title: 'Leftover FLIPPER_VERSION in android/gradle.properties',
      detail: 'Nothing uses it (Flipper is not wired into the build). Delete the line so nobody wonders whether Flipper is still there.',
    });
  }

  // Podfile still loading the CLI's native_modules.rb: React Native provides use_native_modules!
  // itself, and the CLI that ships with React Native 0.80 no longer has this file.
  if (/require_relative\s+['"][^'"]*@react-native-community\/cli-platform-ios\/native_modules['"]/.test(podfile)) {
    add({
      id: 'podfile-cli-native-modules',
      severity: rn !== null && rn >= 80 ? 'high' : 'medium',
      area: 'native',
      title: 'Podfile loads @react-native-community/cli-platform-ios/native_modules',
      detail: "React Native provides use_native_modules! itself. The CLI used from React Native 0.80 no longer ships this file, so pod install fails with \"cannot load such file\". Delete the require_relative line.",
      fix: { kind: 'podfile-cli-require' },
    });
  }

  // RCTAppDelegate is deprecated in favour of RCTReactNativeFactory.
  if (hasIos && rn !== null && rn >= 80) {
    const delegates = findFiles(path.join(root, 'ios'), (name) => /^AppDelegate\.(h|mm|m|swift)$/.test(name));
    if (delegates.some((f) => /:\s*RCTAppDelegate\b|RCTAppDelegate\s*\{|class\s+\w+\s*:\s*RCTAppDelegate/.test(read(f) || ''))) {
      add({
        id: 'ios-rctappdelegate-deprecated',
        severity: 'low',
        area: 'native',
        title: 'AppDelegate subclasses RCTAppDelegate, which is deprecated',
        detail: 'React Native marks RCTAppDelegate as deprecated and to be removed; the template uses RCTReactNativeFactory with a RCTDefaultReactNativeFactoryDelegate. Migrate before the version that removes it.',
        fix: { kind: 'rctappdelegate' },
      });
    }
  }

  // patch-package patches: they silently stop applying, and they are written against one
  // version of a library and one version of React Native.
  const patchDir = path.join(root, 'patches');
  let patchFiles = [];
  try {
    patchFiles = fs.readdirSync(patchDir).filter((f) => f.endsWith('.patch'));
  } catch {
    patchFiles = [];
  }
  const patched = [];
  for (const f of patchFiles) {
    const m = f.match(/^(.+?)\+(\d+\.\d+\.\d+[^.]*)(?:\+\d+)?\.patch$/);
    if (!m) continue;
    const pkg = m[1].replace(/\+/g, '/');
    const version = m[2];
    patched.push({ file: f, pkg, version });
    const text = read(path.join(patchDir, f)) || '';
    const buildPaths = (text.match(/^diff --git a\/node_modules\/\S+?\/(?:android|ios)\/(?:build|\.cxx|\.gradle)\//gm) || []).length;
    const binary = /^GIT binary patch|^Binary files /m.test(text);
    if (buildPaths || binary) {
      add({
        id: `patch-artifacts:${f}`,
        severity: 'high',
        area: 'native',
        title: `Patch contains build output and will not apply on a clean install (patches/${f})`,
        detail: `${buildPaths ? `${buildPaths} file(s) under android/ios build folders` : 'binary content'} were captured when the patch was created. On CI or a new machine patch-package fails and the fix is silently missing. Recreate it with \`npx patch-package ${pkg} --exclude '(^package\\.json$|/build/)'\` from a clean copy.`,
        fix: { kind: 'patch-artifacts', file: f, pkg },
      });
    }
    const installed = project.deps[pkg] || (project.devDeps && project.devDeps[pkg]) ? installedVersionOf(root, pkg) : null;
    if (installed && installed !== version) {
      add({
        id: `patch-version:${f}`,
        severity: 'high',
        area: 'native',
        title: `Patch for ${pkg} ${version} does not match the installed ${installed} (patches/${f})`,
        detail: 'patch-package refuses or misapplies patches written for another version. Re-check whether the fix is still needed on this version and recreate the patch, or delete it.',
        fix: { kind: 'patch-version', file: f, pkg, version, installed },
      });
    }
  }
  if (patched.length) {
    add({
      id: 'patches-present',
      severity: 'info',
      area: 'native',
      title: `${patched.length} patch-package patch${patched.length === 1 ? '' : 'es'}: ${patched.map((p) => p.pkg).join(', ')}`,
      detail: 'Each was written against one library version and one React Native version. After every upgrade step check that each still applies and is still needed; a patch that adapted a library to an older React Native can break it on a newer one.',
      fix: { kind: 'patches-review', patches: patched },
    });
  }

  // Old projects keep the C++ flags of the template they were created from. With
  // -DFOLLY_NO_CONFIG but no -DFOLLY_CFG_NO_COROUTINES, an Objective-C++ AppDelegate that
  // includes React headers fails from React Native 0.80: 'folly/coro/Coroutine.h' file not found.
  if (hasIos) {
    const pbx = findFiles(path.join(root, 'ios'), (name, full) => name === 'project.pbxproj' && !full.includes('Pods.xcodeproj'));
    const objcppDelegate = findFiles(path.join(root, 'ios'), (name) => name === 'AppDelegate.mm').length > 0;
    const stale = pbx.find((f) => {
      const text = read(f) || '';
      return /-DFOLLY_NO_CONFIG/.test(text) && !/FOLLY_CFG_NO_COROUTINES/.test(text);
    });
    const target = minorOf(rnLatest);
    if (stale && objcppDelegate && rn !== null && (rn >= 80 || (target !== null && target >= 80))) {
      add({
        id: 'ios-folly-flags',
        severity: rn >= 80 ? 'high' : 'medium',
        area: 'native',
        title: `Xcode project lacks -DFOLLY_CFG_NO_COROUTINES (${path.relative(root, stale)})`,
        detail: `OTHER_CPLUSPLUSFLAGS comes from an older template. From React Native 0.80 an Objective-C++ AppDelegate fails to compile with "'folly/coro/Coroutine.h' file not found". Add "-DFOLLY_CFG_NO_COROUTINES=1" and "-DFOLLY_HAVE_CLOCK_GETTIME=1" next to "-DFOLLY_USE_LIBCPP=1" in both build configurations, as in the current template.`,
        fix: { kind: 'folly-flags', file: path.relative(root, stale) },
      });
    }
  }

  // Java MainApplication calling getDefaultReactHost(context, host): from React Native 0.80 the
  // Kotlin function has a third JSRuntimeFactory parameter whose default Java cannot see.
  if (hasAndroid && rn !== null) {
    const target = minorOf(rnLatest);
    const javaApps = findFiles(path.join(root, 'android', 'app', 'src', 'main'), (name) => name === 'MainApplication.java');
    const call = javaApps.find((f) => /getDefaultReactHost\(\s*[^,()]+(?:\([^)]*\))?\s*,\s*[^,()]+\)/.test(read(f) || ''));
    if (call && (rn >= 80 || (target !== null && target >= 80))) {
      add({
        id: 'android-default-react-host',
        severity: rn >= 80 ? 'high' : 'low',
        area: 'native',
        title: `MainApplication.java calls getDefaultReactHost with two arguments (${path.relative(root, call)})`,
        detail: 'From React Native 0.80 this fails to compile from Java ("no suitable method found for getDefaultReactHost(Context,ReactNativeHost)"). Pass null as the third JSRuntimeFactory argument, or convert MainApplication to Kotlin like the template.',
        fix: { kind: 'default-react-host', file: path.relative(root, call) },
      });
    }
  }

  // Hermes: JavaScriptCore is no longer bundled with React Native.
  const hermesOff = /^\s*hermesEnabled\s*=\s*false/m.test(gradleProps) || /:hermes_enabled\s*=>\s*false/.test(podfile);
  if (hermesOff) {
    add({
      id: 'hermes-disabled',
      severity: 'medium',
      area: 'native',
      title: 'Hermes is disabled (JavaScriptCore)',
      detail: 'JavaScriptCore is no longer part of React Native; newer versions need the community JSC package. Switching to Hermes is the supported path and usually faster.',
      fix: { kind: 'enable-hermes' },
    });
  }

  // iOS privacy manifest: required by App Store Connect since 1 May 2024. React Native itself
  // uses "required reason" APIs, so every React Native app needs one.
  if (hasIos && !project.isLibrary) {
    const manifests = findFiles(path.join(root, 'ios'), (name) => name.endsWith('.xcprivacy'));
    // From 0.75, `pod install` writes the manifest (with React Native's and the pods' reasons)
    // and adds it to the app target, unless the Podfile turns aggregation off.
    const aggregationOff = /privacy_file_aggregation_enabled\s*(?:=>|:)\s*false|RCT_AGGREGATE_PRIVACY_FILES['"]?\]?\s*=\s*['"]?0/.test(podfile);
    const generated = rn !== null && rn >= 75 && !aggregationOff;
    if (!manifests.length && generated) {
      add({
        id: 'ios-privacy-manifest',
        severity: 'low',
        area: 'store',
        title: 'iOS privacy manifest is generated at pod install, not committed',
        detail: "React Native 0.75+ creates PrivacyInfo.xcprivacy during `pod install` with the required-reason APIs of React Native and your pods. Commit it, then add what only you know: collected data types and tracking. App Store Connect checks those too.",
        fix: { kind: 'privacy-manifest', generated: true },
      });
    } else if (!manifests.length) {
      add({
        id: 'ios-privacy-manifest',
        severity: 'high',
        area: 'store',
        title: 'iOS privacy manifest (PrivacyInfo.xcprivacy) is missing',
        detail: `App Store Connect rejects uploads that use required-reason APIs without declaring them. React Native uses several (UserDefaults, file timestamps, system boot time). ${rn !== null && rn < 75 ? 'React Native before 0.75 does not add it to the app for you: ' : ''}Add PrivacyInfo.xcprivacy to the app target.`,
        fix: { kind: 'privacy-manifest' },
      });
    }
  }

  // Platform minimums of the latest React Native: upgrading drops older OS versions.
  const latestMinor = minorOf(rnLatest);
  if (latestMinor !== null && rn !== null && latestMinor > rn) {
    const minSdk = project.android && project.android.minSdk;
    if (minSdk && minSdk < PLATFORM_MINIMUMS.androidMinSdk) {
      add({
        id: 'android-min-sdk',
        severity: 'info',
        area: 'native',
        title: `minSdk ${minSdk} is below what current React Native supports (${PLATFORM_MINIMUMS.androidMinSdk})`,
        detail: `Upgrading raises the minimum to Android API ${PLATFORM_MINIMUMS.androidMinSdk}. Check how many of your users are on older Android versions first.`,
        fix: { kind: 'min-sdk', to: PLATFORM_MINIMUMS.androidMinSdk },
      });
    }
    const iosMin = podfile.match(/platform\s+:ios\s*,\s*['"](\d+(?:\.\d+)?)['"]/);
    if (iosMin && Number(iosMin[1]) < PLATFORM_MINIMUMS.iosMin) {
      add({
        id: 'ios-min-version',
        severity: 'info',
        area: 'native',
        title: `iOS deployment target ${iosMin[1]} is below what current React Native supports (${PLATFORM_MINIMUMS.iosMin})`,
        detail: `Upgrading raises the minimum to iOS ${PLATFORM_MINIMUMS.iosMin}. Check how many of your users are on older iOS versions first.`,
        fix: { kind: 'ios-min', to: PLATFORM_MINIMUMS.iosMin },
      });
    }
  }

  // Android security settings in the main (shipped) manifest.
  const manifest = read(path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'));
  if (manifest) {
    if (/android:debuggable\s*=\s*"true"/.test(manifest)) {
      add({
        id: 'android-debuggable',
        severity: 'high',
        area: 'security',
        title: 'android:debuggable="true" in the release manifest',
        detail: 'Anyone can attach a debugger to the installed app and read its memory. Remove it; Gradle sets it for debug builds automatically.',
        fix: { kind: 'manifest', attr: 'android:debuggable' },
      });
    }
    if (/android:usesCleartextTraffic\s*=\s*"true"/.test(manifest)) {
      add({
        id: 'android-cleartext',
        severity: 'medium',
        area: 'security',
        title: 'Cleartext HTTP is allowed in the release manifest',
        detail: 'android:usesCleartextTraffic="true" lets the app send data unencrypted. Keep it only in src/debug/AndroidManifest.xml (Metro needs it in development), or allow specific domains with a network security config.',
        fix: { kind: 'manifest', attr: 'android:usesCleartextTraffic' },
      });
    }
  }

  // iOS App Transport Security disabled for all domains.
  if (hasIos) {
    for (const plist of findFiles(path.join(root, 'ios'), (name) => name === 'Info.plist')) {
      const text = read(plist) || '';
      if (/<key>NSAllowsArbitraryLoads<\/key>\s*<true\s*\/>/.test(text)) {
        add({
          id: `ios-ats:${path.relative(root, plist)}`,
          severity: 'medium',
          area: 'security',
          title: `App Transport Security is disabled (${path.relative(root, plist)})`,
          detail: 'NSAllowsArbitraryLoads = true allows unencrypted HTTP to every domain, and App Review may ask you to justify it. Use NSExceptionDomains for the few hosts that need it.',
          fix: { kind: 'ats', file: path.relative(root, plist) },
        });
      }
    }
  }

  // Signing material in the repository. Release keystores and App Store Connect API keys let
  // someone publish as you. The debug keystore and its public 'android' password are fine.
  const tracked = gitTracked(root);
  if (tracked) {
    const nonEmpty = (f) => {
      try {
        return fs.statSync(path.join(root, f)).size > 0;
      } catch {
        return false;
      }
    };
    const signing = tracked.filter((f) => /\.(jks|keystore)$/i.test(f) && !/debug/i.test(path.basename(f)) && nonEmpty(f));
    for (const f of signing) {
      add({
        id: `signing-keystore:${f}`,
        severity: 'high',
        area: 'secret',
        title: `Release signing keystore committed (${f})`,
        detail: 'With the keystore and its passwords anyone can sign builds as you. Move it out of the repository and into your CI secret store; Play App Signing lets you reset the upload key if it leaked.',
        fix: { kind: 'secret', label: 'Release keystore', file: f, line: 1, bundled: false },
      });
    }
    // An empty placeholder file is not a key (some repos commit one so fastlane paths resolve).
    const hasContent = (f, marker) => {
      try {
        const text = fs.readFileSync(path.join(root, f), 'utf8');
        return marker ? text.includes(marker) : text.length > 0;
      } catch {
        return false;
      }
    };
    for (const f of tracked.filter((x) => /(^|\/)AuthKey_[A-Z0-9]+\.p8$/.test(x) && hasContent(x, 'PRIVATE KEY'))) {
      add({
        id: `signing-asc-key:${f}`,
        severity: 'critical',
        area: 'secret',
        title: `App Store Connect API key committed (${f})`,
        detail: 'This key can upload and release builds and change your App Store listing. Revoke it in App Store Connect → Users and Access → Integrations, then keep the new one in CI secrets.',
        fix: { kind: 'secret', label: 'App Store Connect API key', file: f, line: 1, bundled: false },
      });
    }
    for (const f of tracked.filter((x) => /\.p12$/i.test(x) && nonEmpty(x))) {
      add({
        id: `signing-p12:${f}`,
        severity: 'high',
        area: 'secret',
        title: `Signing certificate with private key committed (${f})`,
        detail: 'A .p12 contains a certificate and its private key. Revoke the certificate in the Apple Developer portal and keep signing identities in CI secrets or a match repository.',
        fix: { kind: 'secret', label: 'Signing certificate', file: f, line: 1, bundled: false },
      });
    }
    const passwordFiles = ['android/gradle.properties', 'android/app/build.gradle', 'android/app/build.gradle.kts'].filter((f) => tracked.includes(f));
    for (const f of passwordFiles) {
      const text = read(path.join(root, f)) || '';
      const leaked = [
        ...[...text.matchAll(/^\s*([A-Z0-9_]*(?:STORE|KEY)_PASSWORD)\s*=\s*(\S+)\s*$/gm)].map((m) => ({ name: m[1], value: m[2] })),
        // Not `props['storePassword']`: there the name is a lookup key, not an assignment.
        ...[...text.matchAll(/(?<![\w'"[])(storePassword|keyPassword)\s*=?\s*["']([^"'\n]+)["']/g)].map((m) => ({ name: m[1], value: m[2] })),
      ].filter((l) => l.value !== 'android' && !/^System\.getenv|^\$\{?[A-Z_]+\}?$/.test(l.value));
      if (leaked.length) {
        add({
          id: `signing-password:${f}`,
          severity: 'high',
          area: 'secret',
          title: `Release signing password${leaked.length > 1 ? 's' : ''} committed (${f})`,
          detail: `${[...new Set(leaked.map((l) => l.name))].join(', ')}. Anyone with repository access has them. Read them from ~/.gradle/gradle.properties or environment variables instead, and change them if the keystore was ever shared.`,
          fix: { kind: 'secret', label: 'Signing passwords', file: f, line: 1, bundled: false },
        });
      }
    }
  }

  // Environment files compiled into the bundle.
  const bundlesEnv = ['react-native-config', 'react-native-dotenv', 'babel-plugin-transform-inline-environment-variables'].filter(
    (n) => project.deps[n] || (project.devDeps && project.devDeps[n]),
  );
  const isExpo = !!project.expoVersion;
  if (bundlesEnv.length || isExpo) {
    let envFiles = [];
    try {
      envFiles = fs.readdirSync(root).filter((f) => /^\.env(\.|$)/.test(f) && !/example|sample|template/i.test(f));
    } catch {
      envFiles = [];
    }
    for (const f of envFiles) {
      const text = read(path.join(root, f)) || '';
      const risky = text
        .split('\n')
        .map((l) => l.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(\S+)/))
        .filter(Boolean)
        .filter(([, name, value]) => /SECRET|PRIVATE|PASSWORD|PASSWD|SERVICE_ROLE|ADMIN_KEY/.test(name) && value.replace(/["']/g, '').length > 0)
        .filter(([, name]) => bundlesEnv.length || name.startsWith('EXPO_PUBLIC_'))
        .map(([, name]) => name);
      if (risky.length) {
        add({
          id: `env-bundled:${f}`,
          severity: 'high',
          area: 'secret',
          title: `${risky.length} secret-looking variable${risky.length === 1 ? '' : 's'} in ${f} end up inside the app`,
          detail: `${risky.slice(0, 5).join(', ')}. ${bundlesEnv.length ? `${bundlesEnv[0]} compiles` : 'Expo inlines EXPO_PUBLIC_ variables, so'} these values into the JavaScript bundle, where anyone can read them. Keep secrets on a server.`,
          fix: { kind: 'secret', label: 'Environment secrets', file: f, line: 1, bundled: true },
        });
      }
    }
  }

  return findings;
}
