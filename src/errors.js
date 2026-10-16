// Known React Native / Expo build, launch and store errors: what the message means and the fix.
// Each entry's patterns come from the real message: reproduced by us (source "reproduced"), or
// quoted from Apple, Google, Expo or React Native (the pages under site/fix/ cite them).
// `related` are finding id prefixes from the scan, so a match can point at the exact place in
// the project when a path is given.

import { SITE_URL } from './config.js';

const fix = (slug) => `${SITE_URL}/fix/${slug}`;

export const ERRORS = [
  {
    id: 'android-exported',
    match: [/android:exported needs to be explicitly specified/i, /required to specify an explicit value for android:exported/i],
    title: 'Android 12+ needs android:exported on components with an intent filter',
    cause: 'From target SDK 31, every activity, service or receiver with an <intent-filter> must declare android:exported. The manifest merger fails the build without it.',
    fix: ['Add android:exported="true" to the launcher activity and anything other apps must reach (deep links, share targets), "false" to the rest, in android/app/src/main/AndroidManifest.xml.', 'If the merger names a library component, update that library.'],
    related: ['android-exported'],
    page: fix('android-exported'),
  },
  {
    id: 'itms-91061',
    match: [/ITMS-91061/, /Missing privacy manifest/i],
    title: 'App Store Connect: an SDK in the app has no privacy manifest',
    cause: "Apple requires a PrivacyInfo.xcprivacy in the SDKs on its list (Firebase, SDWebImage, Lottie, GoogleUtilities and others). An old version pulled in by a React Native package doesn't have one. Apple's \"hermes\" entry is an unrelated project, not React Native's Hermes.",
    fix: ['Find the pod named in the message in ios/Podfile.lock, see which React Native package depends on it, update that package, run pod install.', 'Common cases: SDWebImage < 5.18.7 from react-native-fast-image (switch to @d11/react-native-fast-image or expo-image), Firebase pods < 10.22.0, lottie-ios < 4.4.0.'],
    related: ['ios-sdk-privacy-manifest', 'ios-privacy-manifest'],
    page: fix('itms-91061-missing-privacy-manifest'),
  },
  {
    id: 'missing-foreground-service-type',
    match: [/MissingForegroundServiceTypeException/],
    title: 'Android 14: a foreground service without a declared type',
    cause: 'Targeting API 34+, startForeground() throws when the service has no android:foregroundServiceType in the manifest.',
    fix: ['Declare the type on the <service> and add the FOREGROUND_SERVICE_<TYPE> permission.', 'If the service belongs to a library, update it (react-native-track-player, background-geolocation declare it themselves); for Notifee, add app.notifee.core.ForegroundService to your manifest with the type.'],
    related: ['play-target-sdk'],
    page: fix('missing-foreground-service-type'),
  },
  {
    id: 'expo-packages-should-be-updated',
    match: [/should be updated for best compatibility with the installed expo version/i],
    title: 'Expo: native packages are not on the versions this SDK was tested with',
    cause: 'Each Expo SDK pins native module versions. A major mismatch (for example Reanimated 3 on an SDK that expects 4) usually fails to build or crashes.',
    fix: ['Run npx expo install --fix.', 'Do not bump these packages past the SDK; move them with the next SDK upgrade.'],
    related: ['expo-sdk-mismatch'],
    page: fix('expo-packages-should-be-updated'),
  },
  {
    id: 'deprecated-core-components',
    match: [/(?:ImageBackground|SafeAreaView|DrawerLayoutAndroid) (?:is|has been) deprecated/],
    title: 'A React Native core component is deprecated and will be removed',
    cause: 'It still works but logs a warning. Once removed, the import is undefined and screens that render it crash. Core SafeAreaView never applied to Android, and Android 15 draws apps edge-to-edge.',
    fix: ["SafeAreaView → import it from 'react-native-safe-area-context' and wrap the root in SafeAreaProvider.", 'ImageBackground → a View with an absolutely positioned Image (StyleSheet.absoluteFill).', 'DrawerLayoutAndroid → react-native-drawer-layout.'],
    related: ['deprecated-core-imports'],
    page: fix('imagebackground-safeareaview-deprecated'),
  },
  {
    id: 'supabase-rls-disabled',
    match: [/rls_disabled_in_public/, /RLS disabled in public/i],
    title: 'Supabase: a public table without row level security',
    cause: 'The anon key ships in every copy of the app, so anyone can read and change every row of a public table without RLS through the REST API.',
    fix: ['alter table public.<table> enable row level security; then add policies for what the app does (for example using (auth.uid() = user_id)).'],
    related: ['supabase-rls-off'],
    page: fix('supabase-rls-disabled'),
  },
  {
    id: 'app-store-5-1-1-v',
    match: [/5\.1\.1\(v\)/, /does not include an option to initiate account deletion/i],
    title: 'App Store 5.1.1(v): account creation without account deletion',
    cause: 'Apps that let people create an account must let them start deleting it inside the app. Google Play requires the same plus a web page.',
    fix: ['Add "Delete account" to the account or settings screen; delete the account and its data on the server (Firebase deleteUser; Supabase from a server with the service role key), sign out, publish the same flow as a web page for Google Play.'],
    related: ['store-account-deletion'],
    page: fix('app-store-account-deletion-5-1-1-v'),
  },
  {
    id: 'app-store-4-8',
    match: [/Guideline 4\.8/, /4\.8 - Design - Login Services/],
    title: 'App Store 4.8: social login without an equivalent private login',
    cause: 'Google, Facebook or other social login for the primary account needs an equivalent option that limits data to name and email and can hide the email: Sign in with Apple.',
    fix: ['Add expo-apple-authentication (Expo) or @invertase/react-native-apple-authentication, enable the capability, show the button next to the others on iOS, link the identity on the backend.'],
    related: ['store-sign-in-with-apple'],
    page: fix('app-store-sign-in-with-apple-4-8'),
  },
  {
    id: 'google-play-target-api',
    match: [/must target at least API level/i],
    title: 'Google Play: target SDK too low',
    cause: 'Since 31 August 2026, new apps and updates must target API level 36.',
    fix: ['Set targetSdkVersion and compileSdkVersion to 36 (Expo: the SDK that targets it, or expo-build-properties).', 'Then handle what each skipped level changes: android:exported (31), foreground service types (34), edge-to-edge (35).'],
    related: ['play-target-sdk'],
    page: fix('google-play-target-api-level'),
  },
  {
    id: 'google-play-16kb',
    match: [/does not support 16 ?KB memory page sizes/i, /16 ?KB (?:memory )?page size/i],
    title: 'Google Play: native libraries not aligned for 16 KB pages',
    cause: 'From 1 February 2027 updates without 16 KB support cannot be released. React Native supports it from 0.77 (Expo SDK 53); after that, the warning comes from a library with its own .so files.',
    fix: ['Below React Native 0.77: upgrade React Native.', 'Otherwise update the library whose .so is not aligned (NativeKeel lists them when a built APK/AAB is in the project).'],
    related: ['android-16kb'],
    page: fix('google-play-16-kb-page-size'),
  },
  {
    id: 'google-play-debug-signed',
    match: [/signed in debug mode/i],
    title: 'Google Play: the release build is signed with the debug key',
    cause: 'The React Native template signs release builds with signingConfigs.debug.',
    fix: ['Create an upload keystore, keep its passwords in ~/.gradle/gradle.properties or CI secrets, add signingConfigs.release and use it in buildTypes.release, upload the .aab.'],
    related: ['android-release-debug-signed', 'signing-'],
    page: fix('signed-in-debug-mode'),
  },
  {
    id: 'uiscene-required',
    match: [/UIScene life cycle is required/i],
    title: 'Xcode 27: the app has not adopted the UIScene life cycle',
    cause: 'Built with the iOS 27 SDK, an app without scene configurations stops at launch. App Store Connect requires that SDK from April 2027.',
    fix: ['React Native: 0.88 is the first template with SceneDelegate; upgrade and copy SceneDelegate.swift and the Info.plist scene manifest from the Upgrade Helper.', 'Expo: SDK 57 with expo 57.0.23+ and expo-build-properties 57.0.20+ and ios.enableSceneSupport: true, or SDK 58.'],
    related: ['ios-uiscene', 'ios-scene-delegate-window'],
    page: fix('uiscene-life-cycle-required-xcode-27'),
  },
  {
    id: 'appdelegate-window-selector',
    match: [/\[AppDelegate window\]: unrecognized selector/, /AppDelegate window\b.*unrecognized selector/],
    title: 'A library reads the window from the app delegate, which the scene life cycle no longer has',
    cause: 'With the UIScene life cycle (React Native 0.88 template, Expo with scene support) the window belongs to the scene delegate, and the AppDelegate has no window property. Libraries that call [UIApplication sharedApplication].delegate.window crash. Reproduced with react-native-blob-util and react-native-google-mobile-ads on the 0.88 template.',
    fix: ['Update the library if a release reads the window with RCTKeyWindow() or RCTPresentedViewController(); otherwise patch it the same way (patch-package) until it does.', 'NativeKeel lists the installed libraries that do this.'],
    related: ['ios-scene-delegate-window'],
    page: fix('uiscene-life-cycle-required-xcode-27'),
    source: 'reproduced on React Native 0.88.0-rc.4',
  },
  {
    id: 'rctcomponent-header-not-found',
    match: [/'RCT\w+\.h' file not found/, /RCT\w+\.h['"]? file not found/],
    title: 'A library includes React Native headers the way 0.87+ no longer resolves',
    cause: 'React Native 0.87 serves its iOS headers from XCFrameworks. #import "RCTBridge.h" no longer resolves with the default prebuilt React Native, and #import <RCTBridge.h> never does; only #import <React/RCTBridge.h> works. Seen with react-native-date-picker 5.0.13, @react-native-menu/menu 2.0.0 and react-native-bottom-tabs 1.4.0.',
    fix: ['Update the library named in the build log; if no release fixes it, patch its imports to the <React/...> form (patch-package).', 'Until then, RCT_USE_PREBUILT_RNCORE=0 pod install (Expo: buildReactNativeFromSource) still resolves the quoted form, with slower clean builds.'],
    related: ['ios-unprefixed-react-imports', 'upcoming-changes'],
    page: fix('rctcomponent-h-file-not-found-react-native-0-87'),
    source: 'reproduced with react-native-date-picker 5.0.13 on React Native 0.88.0-rc.4; React Native 0.87 release notes',
  },
  {
    id: 'removed-from-core',
    match: [/(?<!InteractionManager )has been removed from (?:react-native core|React Native)\./i],
    title: 'An API removed from React Native core is still imported',
    cause: 'Development builds throw this; in release builds the import is undefined and the code that uses it fails.',
    fix: ['Install the community package the message names and change the import.'],
    related: ['crash-removed-core-imports'],
  },
  {
    id: 'interaction-manager-removed',
    match: [/InteractionManager has been removed from react-native core/, /runAfterInteractions['"]? of undefined/, /InteractionManager\.runAfterInteractions/, /\bInteractionManager\b[^\n]*(?:undefined|not an object)/],
    title: 'InteractionManager was removed in React Native 0.87',
    cause: "React Native 0.87 removed InteractionManager, so the import is undefined and runAfterInteractions fails.",
    fix: ['Replace InteractionManager.runAfterInteractions(fn) with requestIdleCallback(fn), and task.cancel() with cancelIdleCallback(id).'],
    related: ['crash-removed-core-imports', 'upcoming-changes'],
    page: fix('interactionmanager-removed-react-native-0-87'),
  },
  {
    id: 'strict-typescript-deep-import',
    match: [/react-native\/Libraries\/[^\s'"]*['"]?[^\n]*(?:TS2307|TS2305|TS2724|Cannot find module|has no exported member)/, /(?:TS2307|Cannot find module)[^\n]*react-native\/Libraries\//],
    title: 'Deep imports from react-native/Libraries are type errors since React Native 0.87',
    cause: 'React Native 0.87 made the Strict TypeScript API the default; only the public react-native entry point is typed.',
    fix: ["Import from 'react-native' instead.", 'To defer: "customConditions": ["react-native", "react-native-legacy-deep-imports"] in tsconfig.json (through 0.88 only).'],
    related: ['upcoming-changes'],
  },
  {
    id: 'reanimated-worklet',
    match: [/failed to create a worklet/i],
    title: 'Reanimated worklets are not compiled',
    cause: "The Babel plugin is missing or not last: react-native-worklets/plugin for Reanimated 4, react-native-reanimated/plugin for 3.",
    fix: ['Add the plugin as the last entry of plugins in babel.config.js, then restart Metro with --reset-cache.'],
    related: ['crash-reanimated'],
  },
  {
    id: 'invalid-hook-call',
    match: [/Invalid hook call/],
    title: 'Invalid hook call: often two copies of React in the bundle',
    cause: 'A dependency that bundles its own react (or react-native) puts a second copy next to yours, so hooks run against a different React.',
    fix: ['Run npm ls react; align the dependency or add an overrides/resolutions entry for react, reinstall.', 'Also check that hooks are only called inside function components.'],
    related: ['crash-duplicate-'],
  },
  {
    id: 'codegen-eventemitter-property',
    match: [/UnsupportedModulePropertyParserError/],
    title: "Codegen rejects a library's TurboModule spec",
    cause: 'The library uses spec features newer than this React Native version\'s codegen understands, for example EventEmitter properties (@dr.pogodin/react-native-fs 2.37+ on 0.77).',
    fix: ['Pin the last library version that supports your React Native (2.36.2 for @dr.pogodin/react-native-fs on 0.77), or upgrade React Native.'],
    related: ['rnfs-fork-codegen-eventemitter'],
    source: 'real upgrade, 2026-10-03',
  },
  {
    id: 'recycle-mounted-view',
    match: [/Attempt to recycle a mounted view/],
    title: 'New Architecture: a legacy component around a Modal',
    cause: 'react-native-linear-gradient 2.x runs through the interop layer; a LinearGradient that contains a Modal (or a Modal-based bottom sheet) can abort the app when it closes (upstream issue #718).',
    fix: ["Draw the gradient with React Native's experimental_backgroundImage: 'linear-gradient(...)' (0.76+), or move the Modal out of the gradient."],
    related: ['linear-gradient-interop-unmount'],
    source: 'real upgrade, 2026-10-04',
  },
];

const MAX_INPUT = 20000;

// Returns the entries whose patterns match the error text, best first (more patterns matched).
export function explainError(text) {
  const input = String(text || '').slice(0, MAX_INPUT);
  if (!input.trim()) return [];
  return ERRORS.map((e) => ({ e, score: e.match.filter((re) => re.test(input)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ e }) => e);
}

export const relatedFindings = (entry, findings) =>
  (findings || []).filter((f) => entry.related && entry.related.some((prefix) => String(f.id).startsWith(prefix)));
