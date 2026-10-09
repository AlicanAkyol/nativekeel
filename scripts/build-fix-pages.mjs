#!/usr/bin/env node
// Builds site/fix/*.html: one page per error or rejection message people paste into a search
// engine, with the cause, the fix and the sources. Every claim here was checked at the source
// linked on the page; keep it that way when editing.
//   node scripts/build-fix-pages.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const BASE = 'https://nativekeel.com';
const UPDATED = '2026-10-08';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Inside an attribute a " would end the value (search engines then see half a description).
const attr = (s) => esc(s).replace(/"/g, '&quot;');
// Tiny markup: `code`, **bold**, [text](url), blank line = paragraph, lines starting with "- " = list,
// ``` fenced blocks.
function md(src) {
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  const out = [];
  const blocks = src.trim().split(/\n```/);
  blocks.forEach((b, i) => {
    if (i % 2 === 1) {
      const nl = b.indexOf('\n');
      out.push(`<pre><code>${esc(b.slice(nl + 1).replace(/\n```?\s*$/, ''))}</code></pre>`);
      return;
    }
    for (const para of b.replace(/^```\s*/, '').split(/\n\s*\n/)) {
      const lines = para.trim().split('\n');
      if (!lines[0]) continue;
      if (lines.every((l) => l.startsWith('- '))) out.push(`<ul>${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join('')}</ul>`);
      else out.push(`<p>${inline(lines.join(' '))}</p>`);
    }
  });
  return out.join('\n');
}

const PAGES = [
  {
    slug: 'android-exported',
    error: 'Manifest merger failed: android:exported needs to be explicitly specified',
    title: 'android:exported needs to be explicitly specified (React Native, targetSdk 31+)',
    description: 'Why a React Native build fails with "android:exported needs to be explicitly specified" after raising targetSdk, and how to fix every component at once.',
    body: `
The full message usually reads:

\`\`\`
Manifest merger failed : Apps targeting Android 12 and higher are required to specify an explicit value for android:exported when the corresponding component has an intent filter defined.
\`\`\`

**What it means.** From Android 12 (target SDK 31), every activity, service or broadcast receiver that has an \`<intent-filter>\` must say whether other apps may start it. Without \`android:exported\`, the build fails, and an app built anyway cannot be installed on Android 12 or newer.

**Why React Native apps hit it now.** Google Play requires new apps and updates to target API level 36, so apps that stayed on target 30 or lower meet this the moment they raise the target. In our scan of 653 open-source React Native apps, 107 would.

**How to fix it.** In \`android/app/src/main/AndroidManifest.xml\`, add the attribute to each component with an intent filter: \`"true"\` for the launcher activity and anything another app must reach (deep links, share targets), \`"false"\` for the rest.

\`\`\`
<activity
  android:name=".MainActivity"
  android:exported="true">
  <intent-filter>
    <action android:name="android.intent.action.MAIN" />
    <category android:name="android.intent.category.LAUNCHER" />
  </intent-filter>
</activity>
\`\`\`

If the merger names a component from a library, update that library: current releases declare it themselves. As a stopgap you can override it in your own manifest with \`tools:node="merge"\` and the attribute.

**Find every one before you raise the target.** \`npx nativekeel\` lists each component that is missing the attribute, and its upgrade plan fixes them before the target SDK step.`,
    sources: [['Android 12 behavior changes: safer component exporting', 'https://developer.android.com/about/versions/12/behavior-changes-12#exported'], ['Google Play target API level requirement', 'https://support.google.com/googleplay/android-developer/answer/11926878']],
  },
  {
    slug: 'itms-91061-missing-privacy-manifest',
    error: 'ITMS-91061: Missing privacy manifest',
    title: 'ITMS-91061: Missing privacy manifest in a React Native app',
    description: 'What App Store Connect\'s ITMS-91061 "Missing privacy manifest" means for React Native and Expo apps, which pods cause it, and which package to update.',
    body: `
Apple's message looks like this:

\`\`\`
ITMS-91061: Missing privacy manifest - Your app includes "Frameworks/FirebaseCore.framework/FirebaseCore", which includes FirebaseCore, an SDK that was identified in the documentation as a privacy-impacting third-party SDK. Starting February 12, 2025, if a new app includes a privacy-impacting SDK, or an app update adds a new privacy-impacting SDK, the SDK must include a privacy manifest file.
\`\`\`

**What it means.** Apple keeps a list of commonly used SDKs (Firebase, SDWebImage, Lottie, GoogleUtilities, Alamofire, nanopb and others) that must ship a \`PrivacyInfo.xcprivacy\` file. A new app that contains an old version of one of them, or an update that adds one, is refused until the SDK has a manifest.

**Where it comes from in React Native.** You rarely add these pods yourself: a React Native package pulls them in. The most common cases we see:

- \`SDWebImage\` before 5.18.7, pinned by \`react-native-fast-image\` (unmaintained; \`@d11/react-native-fast-image\` or \`expo-image\` are current).
- Firebase pods before 10.22.0, from an old \`@react-native-firebase/*\`.
- \`lottie-ios\` before 4.4.0, from an old \`lottie-react-native\`.

**How to fix it.** Update the React Native package that depends on the pod, run \`pod install\`, and check \`ios/Podfile.lock\` for the new version. Look up the chain in \`Podfile.lock\` (the PODS section lists who depends on what) to find that package.

**One thing that is not the problem.** The "hermes" on Apple's list is a 2015 Imgur project, not React Native's Hermes engine; the React Native team confirmed this with Apple.

**Find them all.** \`npx nativekeel\` reads \`Podfile.lock\`, lists each SDK that is older than its first release with a manifest, and names the React Native package to update. In our scan, 24 of 116 apps with a Podfile.lock had at least one.`,
    sources: [['Apple: third-party SDK requirements and the SDK list', 'https://developer.apple.com/support/third-party-SDK-requirements/'], ['React Native discussion on privacy manifests and Hermes', 'https://github.com/react-native-community/discussions-and-proposals/discussions/776']],
  },
  {
    slug: 'missing-foreground-service-type',
    error: 'MissingForegroundServiceTypeException',
    title: 'MissingForegroundServiceTypeException in React Native (Android 14)',
    description: 'Why a React Native app crashes with MissingForegroundServiceTypeException after targeting Android 14, and how to declare the foreground service type.',
    body: `
**What it means.** If your app targets Android 14 (API level 34) and starts a foreground service whose type is not declared in the manifest, the system throws \`MissingForegroundServiceTypeException\` when the service calls \`startForeground()\`. The app crashes at that moment, not at build time.

**How to fix it.** Declare the type on the service and add the matching permission:

\`\`\`
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />

<service
  android:name=".MyMediaPlaybackService"
  android:foregroundServiceType="mediaPlayback"
  android:exported="false" />
\`\`\`

**In React Native apps** the service usually belongs to a library. Current releases of \`react-native-track-player\` and \`react-native-background-geolocation\` declare their type themselves, so updating fixes it. With Notifee foreground services, add \`app.notifee.core.ForegroundService\` to your own manifest with the type you use, as Notifee's documentation shows.

**Check your app.** \`npx nativekeel\` checks your target SDK and the native setup that changes with it.`,
    sources: [['Android 14: foreground service types are required', 'https://developer.android.com/about/versions/14/changes/fgs-types-required'], ['Notifee: foreground service', 'https://notifee.app/react-native/docs/android/foreground-service']],
  },
  {
    slug: 'expo-packages-should-be-updated',
    error: 'The following packages should be updated for best compatibility with the installed expo version',
    title: 'Expo: "The following packages should be updated for best compatibility"',
    description: 'What Expo\'s "packages should be updated for best compatibility with the installed expo version" warning means, when it causes crashes, and the one-command fix.',
    body: `
Expo prints:

\`\`\`
The following packages should be updated for best compatibility with the installed expo version:
  react-native-reanimated@3.19.5 - expected version: ~4.1.1
Your project may not work correctly until you install the expected versions of the packages.
\`\`\`

**What it means.** Every Expo SDK release is tested with specific versions of native libraries (listed in the SDK's \`bundledNativeModules.json\`). A native module from another release is one of the most common causes of build failures and launch crashes in Expo apps.

**How much it matters.** A patch difference (15.15.5 instead of 15.15.4) is usually harmless. A minor difference can change behaviour. A major difference (Reanimated 3 on an SDK that expects 4) usually fails to build or crashes.

**How to fix it.**

\`\`\`
npx expo install --fix
\`\`\`

It sets every package to the version your SDK expects. Do not bump these packages past the SDK yourself: move them with the next SDK upgrade instead.

**How common it is.** In our scan, 144 of 390 Expo apps with a lockfile had at least one package off the SDK's version, most often Reanimated, react-native-safe-area-context and react-native-screens. \`npx nativekeel\` reports them with the size of each gap, even without \`node_modules\` installed.`,
    sources: [['Expo: npx expo install', 'https://docs.expo.dev/more/expo-cli/#install']],
  },
  {
    slug: 'imagebackground-safeareaview-deprecated',
    error: 'ImageBackground is deprecated and will be removed in a future release',
    title: 'ImageBackground and SafeAreaView are deprecated in React Native: how to migrate',
    description: 'React Native 0.87 deprecated ImageBackground (and 0.81 SafeAreaView). Why SafeAreaView already misbehaves on Android 15, and drop-in replacements for both.',
    body: `
React Native logs:

\`\`\`
ImageBackground is deprecated and will be removed in a future release. Use a View with an absolutely positioned Image instead.
SafeAreaView has been deprecated and will be removed in a future release. Please use 'react-native-safe-area-context' instead.
\`\`\`

**What it means.** Both still work and log a warning. Once removed, importing them from \`'react-native'\` returns \`undefined\` and every screen that renders them crashes. \`ImageBackground\` was deprecated in 0.87, \`SafeAreaView\` in 0.81 (\`DrawerLayoutAndroid\` and \`UTFSequence\` in 0.87 too).

**SafeAreaView is already a problem on Android.** The core component only ever applied to iOS. Apps that target Android 15 (API level 35) are drawn edge-to-edge there, so screens wrapped in it sit under the status bar. Replace it with the one from \`react-native-safe-area-context\` and wrap the root in \`SafeAreaProvider\` (Expo Router already does).

\`\`\`
- import { SafeAreaView } from 'react-native';
+ import { SafeAreaView } from 'react-native-safe-area-context';
\`\`\`

**ImageBackground** is a View with an absolutely positioned Image:

\`\`\`
<View style={style}>
  <Image source={source} resizeMode="cover" style={StyleSheet.absoluteFill} />
  {children}
</View>
\`\`\`

Add \`overflow: 'hidden'\` to the outer style if you used \`borderRadius\`.

**Find every import.** \`npx nativekeel\` lists each one with its file and line. In our scan, 183 of 653 apps import at least one. A longer walkthrough is on [dev.to](https://dev.to/keel_alican_akyol/imagebackground-and-safeareaview-are-deprecated-183-of-653-react-native-apps-still-use-them-35ff).`,
    sources: [['React Native: ImageBackground', 'https://reactnative.dev/docs/imagebackground'], ['React Native: SafeAreaView', 'https://reactnative.dev/docs/safeareaview'], ['Android 15: edge-to-edge enforcement', 'https://developer.android.com/about/versions/15/behavior-changes-15']],
  },
  {
    slug: 'supabase-rls-disabled',
    error: 'Supabase: RLS disabled in public (0013_rls_disabled_in_public)',
    title: 'Supabase tables without row level security in a React Native app',
    description: 'Why a Supabase table without row level security is readable by anyone who has your React Native or Expo app, and how to enable RLS with policies.',
    body: `
Supabase's security advisor reports it as lint \`0013_rls_disabled_in_public\`.

**What it means.** Your app talks to Supabase with the anon key, and that key ships inside every copy of the app. Anyone can extract it and call the REST API directly. For a table in the \`public\` schema without row level security, that means reading and changing every row.

**How to fix it.** Enable RLS and add a policy for the access each table needs, in a migration:

\`\`\`
alter table public.todos enable row level security;

create policy "Users read their own todos"
  on public.todos for select
  using (auth.uid() = user_id);
\`\`\`

With RLS on and no policy, nobody can read the table through the API, so add policies for what the app does.

**A detail we see in real apps.** The \`enable row level security\` line written but commented out. In our scan, 3 of 15 apps with Supabase migrations had at least one public table without RLS, one of them a starter template with payment and invoice log tables.

**Check your repository.** \`npx nativekeel\` reads the migrations under \`supabase/\` and lists public tables that never enable RLS. Also check the dashboard (Table Editor) for tables created there.`,
    sources: [['Supabase: row level security', 'https://supabase.com/docs/guides/database/postgres/row-level-security'], ['Supabase: database advisors', 'https://supabase.com/docs/guides/database/database-advisors']],
  },
  {
    slug: 'app-store-account-deletion-5-1-1-v',
    error: 'Guideline 5.1.1(v): the app supports account creation but does not include an option to initiate account deletion',
    title: 'App Store rejection 5.1.1(v): account deletion in a React Native app',
    description: 'Why Apple rejects React Native and Expo apps under guideline 5.1.1(v), what counts as account deletion, and what Google Play asks for as well.',
    body: `
The rejection reads:

\`\`\`
Guideline 5.1.1(v) - Data Collection and Storage
The app supports account creation but does not include an option to initiate account deletion. Apps that support account creation must also offer account deletion to give users more control of the data they've shared while using an app.
\`\`\`

**What Apple asks for.** If people can create an account in your app, they must be able to start deleting it from inside the app. Deactivating or disabling the account is not enough. If deletion has to finish on a website, the app must link directly to that page. A confirmation step is fine.

**Google Play asks for the same, plus a web link.** Apps that let users create an account must offer an in-app path to delete it and its data, and a web page where deletion can be requested, declared in the Data safety form in Play Console.

**How to fix it.** Add "Delete account" to the account or settings screen. It should delete the account and its data on your server (or start that request), sign the user out, and say what happens. With Firebase that is \`deleteUser\` (the user may need to sign in again first); with Supabase it is a server-side call with the service role key, never from the app. Publish the same flow as a web page for Google Play.

**How common it is.** In our scan of 653 open-source React Native apps, 43 sign users up (Firebase, Supabase, Amplify, Appwrite, Clerk or their own /signup API) with no account deletion anywhere in the code. \`npx nativekeel\` flags it before you submit.`,
    sources: [['App Review Guidelines 5.1.1(v)', 'https://developer.apple.com/app-store/review/guidelines/'], ['Apple: offering account deletion in your app', 'https://developer.apple.com/support/offering-account-deletion-in-your-app/'], ['Google Play: account deletion requirements', 'https://support.google.com/googleplay/android-developer/answer/13327111']],
  },
  {
    slug: 'app-store-sign-in-with-apple-4-8',
    error: 'Guideline 4.8 - Design - Login Services',
    title: 'App Store rejection 4.8 (Login Services): Sign in with Apple in a React Native app',
    description: 'Why an iOS app with Google or Facebook login is rejected under App Store guideline 4.8, the exceptions, and how to add Sign in with Apple in React Native and Expo.',
    body: `
**What the guideline says.** Apps that use a third-party or social login (Google, Facebook, Log in with X and others) to set up or authenticate the user's primary account must also offer an equivalent login that:

- limits data collection to the user's name and email address;
- lets users keep their email address private;
- does not collect interactions with your app for advertising without consent.

Sign in with Apple meets all three, which is why it is the usual fix.

**When it does not apply.** Your app only uses your company's own accounts; it is an education, enterprise or business app that requires an existing account of that kind; it uses a government or industry-backed ID; or it is a client for a specific third-party service where users sign in to that service to reach their content. Using Google only to connect a service (for example Drive backups) is not the primary account.

**How to add it.**

\`\`\`
npx expo install expo-apple-authentication        # Expo
npm install @invertase/react-native-apple-authentication   # bare React Native
\`\`\`

Enable the Sign in with Apple capability for the app ID, show Apple's button next to the other providers on iOS, and link the Apple identity to the same account on your backend.

**How common it is.** In our scan, 11 apps use Google or Facebook login on iOS with nothing equivalent. \`npx nativekeel\` flags it and lists the exceptions so you can decide.`,
    sources: [['App Review Guidelines 4.8 Login Services', 'https://developer.apple.com/app-store/review/guidelines/']],
  },
  {
    slug: 'google-play-target-api-level',
    error: 'Your app currently targets API level 34 and must target at least API level 36',
    title: 'Google Play: "must target at least API level" in a React Native app',
    description: 'What Google Play\'s target API level error means for React Native and Expo apps in 2026, the deadlines, and what usually breaks when you raise targetSdk.',
    body: `
Play Console shows:

\`\`\`
Your app currently targets API level 34 and must target at least API level 36 to ensure that it is built on the latest APIs optimized for security and performance.
\`\`\`

**The rule in 2026.** Since 31 August 2026, new apps and app updates must target Android 16 (API level 36). Existing apps must target at least Android 15 (API level 35) to stay available to new users on newer Android versions. Apps that requested an extension have until 1 November 2026.

**How to fix it in React Native.** Set \`targetSdkVersion = 36\` and \`compileSdkVersion = 36\` in \`android/build.gradle\` (Expo: use the SDK that targets it, or \`expo-build-properties\`). Then check what changes with each API level you skip:

- Target 31: components with an intent filter need \`android:exported\`, or the build fails ([details](/fix/android-exported)).
- Target 34: foreground services must declare their type, or the app crashes when one starts ([details](/fix/missing-foreground-service-type)).
- Target 35: the app is drawn edge-to-edge on Android 15, so screens using React Native's own \`SafeAreaView\` slide under the status bar ([details](/fix/imagebackground-safeareaview-deprecated)).

**Check your app first.** \`npx nativekeel\` reports the target SDK problem and each of these follow-on issues, and its upgrade plan orders them.`,
    sources: [['Google Play target API level requirements', 'https://support.google.com/googleplay/android-developer/answer/11926878']],
  },
  {
    slug: 'google-play-16-kb-page-size',
    error: 'Your app does not support 16 KB memory page sizes',
    title: 'Google Play 16 KB page size warning in a React Native app',
    description: 'What Google Play\'s 16 KB memory page size warning means for React Native and Expo apps, the 1 February 2027 deadline, and which version fixes it.',
    body: `
**What it means.** Apps that target Android 15 or higher must support 16 KB memory pages on 64-bit devices. Native libraries (\`.so\` files) built for 4 KB pages do not load on those devices. Google's page says: starting 1 February 2027, if your app updates don't support 16 KB memory page sizes, you won't be able to release them. Until then Play Console warns.

**In React Native.** React Native supports 16 KB pages from 0.77. In Expo that means SDK 53 or later (SDK 52 ships React Native 0.76). Below that, upgrading React Native is the fix. Above it, the warning comes from a library that ships its own native code: update that library, or rebuild it with NDK r28 or newer.

**Find the library.** Open your release AAB or APK and check each 64-bit \`.so\` file's alignment. \`npx nativekeel\` does this when a built APK/AAB is in the project, lists the libraries that are not aligned, and flags React Native versions before 0.77 even without a build.`,
    sources: [['Android: support 16 KB page sizes', 'https://developer.android.com/guide/practices/page-sizes']],
  },
  {
    slug: 'signed-in-debug-mode',
    error: 'You uploaded an APK or Android App Bundle that was signed in debug mode',
    title: 'Google Play: "signed in debug mode" in a React Native app',
    description: 'Why Google Play refuses a React Native release build "signed in debug mode", and how to set up release signing without committing your passwords.',
    body: `
**What it means.** Google Play only accepts uploads signed with your own key. The React Native template signs release builds with the debug key, which is the same public key on every machine:

\`\`\`
release {
    // Caution! In production, you need to generate your own keystore file.
    signingConfig signingConfigs.debug
}
\`\`\`

**How to fix it.** Create an upload key once and keep it out of the repository:

\`\`\`
keytool -genkeypair -v -storetype PKCS12 -keystore upload.keystore -alias upload -keyalg RSA -keysize 2048 -validity 10000
\`\`\`

Put the passwords in \`~/.gradle/gradle.properties\` (or CI secrets), not in the project, then sign the release build with it in \`android/app/build.gradle\`:

\`\`\`
signingConfigs {
    release {
        storeFile file(MYAPP_UPLOAD_STORE_FILE)
        storePassword MYAPP_UPLOAD_STORE_PASSWORD
        keyAlias MYAPP_UPLOAD_KEY_ALIAS
        keyPassword MYAPP_UPLOAD_KEY_PASSWORD
    }
}
buildTypes {
    release {
        signingConfig signingConfigs.release
    }
}
\`\`\`

Build with \`./gradlew bundleRelease\` and upload the \`.aab\`. With Play App Signing, Google re-signs for users and this is your upload key.

**If you build with EAS or sign in CI** (Fastlane, a signing action), the signing happens there and the Gradle setting does not matter.

**How common it is.** In our scan of 653 open-source React Native apps, 62 sign release builds with the debug key and do not sign them elsewhere. \`npx nativekeel\` reports it, together with signing passwords or keystores committed to the repository.`,
    sources: [['React Native: publishing to Google Play Store', 'https://reactnative.dev/docs/signed-apk-android'], ['Android: sign your app', 'https://developer.android.com/studio/publish/app-signing']],
  },
];

const STYLE = `:root{--bg:#fbfaf7;--text:#15171b;--muted:#5d6470;--accent:#0b5d55;--line:#e3e1db;--card:#ffffff;--code:#f1efea}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0e1013;--text:#e9ebef;--muted:#9aa2ad;--accent:#3cc4b4;--line:#262a31;--card:#15181d;--code:#1b1f25}}
:root[data-theme="dark"]{--bg:#0e1013;--text:#e9ebef;--muted:#9aa2ad;--accent:#3cc4b4;--line:#262a31;--card:#15181d;--code:#1b1f25}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 16px 64px;overflow-wrap:anywhere}
h1{font-size:28px;line-height:1.25;margin:0 0 6px}h2{font-size:18px;margin:28px 0 6px}a{color:var(--accent)}p,li{color:var(--muted)}strong{color:var(--text)}
code{font:14px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:1px 5px;border-radius:5px}
pre{background:var(--code);border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow-x:auto}pre code{background:none;padding:0;white-space:pre-wrap}
.cta{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:28px 0}.cta code{font-size:15px}
.meta{font-size:14px;color:var(--muted)}ul.list li{margin:8px 0}`;

const head = (title, description, url) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${attr(description)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#0b5d55">
<link rel="canonical" href="${url}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="NativeKeel">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${attr(title)}">
<meta property="og:description" content="${attr(description)}">
<meta property="og:image" content="${BASE}/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${BASE}/og.png">
<style>${STYLE}</style>
</head>`;

fs.mkdirSync(path.join(SITE, 'fix'), { recursive: true });
for (const p of PAGES) {
  const url = `${BASE}/fix/${p.slug}`;
  const ld = { '@context': 'https://schema.org', '@type': 'TechArticle', headline: p.title, description: p.description, dateModified: UPDATED, author: { '@type': 'Organization', name: 'NativeKeel', url: BASE }, mainEntityOfPage: url };
  const html = `${head(p.title, p.description, url)}
<body><main>
<p class="meta"><a href="/">NativeKeel</a> · <a href="/fix/">React Native fixes</a></p>
<h1>${esc(p.error)}</h1>
<p class="meta">Updated ${UPDATED}</p>
${md(p.body)}
<div class="cta"><strong>Check your whole app in one command:</strong> <code>npx nativekeel</code><br><span class="meta">Free, runs locally (your code is not uploaded), no account. It reports this and 80 other upgrade, store, crash and security problems.</span></div>
<h2>Sources</h2>
<ul>${p.sources.map(([t, u]) => `<li><a href="${u}">${esc(t)}</a></li>`).join('')}</ul>
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
</main></body>
</html>
`;
  fs.writeFileSync(path.join(SITE, 'fix', `${p.slug}.html`), html);
}
const idxTitle = 'React Native and Expo errors, explained and fixed';
const idxDesc = 'Build errors, App Store and Google Play rejections and crashes that React Native and Expo apps hit, with the cause, the fix and sources.';
fs.writeFileSync(
  path.join(SITE, 'fix', 'index.html'),
  `${head(idxTitle, idxDesc, `${BASE}/fix/`)}
<body><main>
<p class="meta"><a href="/">NativeKeel</a></p>
<h1>${idxTitle}</h1>
<p>Each page explains one message: what it means, why React Native and Expo apps hit it, and how to fix it, with the official sources. NativeKeel finds all of these in your project with <code>npx nativekeel</code>.</p>
<ul class="list">${PAGES.map((p) => `<li><a href="/fix/${p.slug}">${esc(p.error)}</a><br><span class="meta">${esc(p.description)}</span></li>`).join('\n')}</ul>
</main></body>
</html>
`,
);
console.log(`wrote ${PAGES.length} pages + index`);
