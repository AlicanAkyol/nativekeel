import fs from 'node:fs';
import path from 'node:path';
import { PRIVACY_SDKS } from './privacy-sdks.js';
import { IOS_SDK_27, SCENE_WINDOW_LIBS } from './rules.js';

// App Store and Google Play review rules that code can show (checked on Apple's App Review
// Guidelines and Google Play's policy pages, October 2026). These are common rejection reasons;
// the checks only report when the code shows the trigger and nothing of the remedy.

const SKIP = new Set(['node_modules', '.git', 'android', 'ios', 'build', 'dist', 'Pods', '__tests__', '__mocks__', 'e2e', '.expo', 'coverage', 'vendor', 'server', 'backend', 'functions', 'supabase']);

function appSource(root) {
  let text = '';
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 8 && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(p, depth + 1);
      } else if (/\.[cm]?[jt]sx?$|\.json$/.test(e.name) && !/\.(?:test|spec)\.|package(?:-lock)?\.json$|tsconfig/.test(e.name)) {
        try {
          if (fs.statSync(p).size < 400 * 1024) text += `\n${fs.readFileSync(p, 'utf8')}`;
        } catch {
          // unreadable
        }
      }
    }
  };
  walk(root, 0);
  return text;
}

// Sign-up in the app itself: auth SDK calls, or the app's own API path. A link to another
// site's sign-up page (a client for a third-party service) is not an account the app creates.
const SIGN_UP = /createUserWithEmailAndPassword|supabase\.auth\.signUp\s*\(|\bauth\.signUp\s*\(|Auth\.signUp\s*\(|account\.create\s*\(\s*(?:ID\.unique|['"`])|signUp\.create\s*\(|useSignUp\s*\(|['"`]\/(?:api\/)?(?:auth\/|users\/|v\d\/)?(?:signup|sign-up)['"`]/;
const DELETION = /deleteUser|deleteAccount|delete[_\- ]?account|deleteMe\b|removeAccount|closeAccount|user\??\.delete\s*\(|currentUser\??\.delete\s*\(|account\.delete|auth\.admin\.deleteUser|deactivateAccount|delete_user|https?:\/\/[^'"`\s]*delet/i;

const SOCIAL_LOGIN = ['@react-native-google-signin/google-signin', '@react-native-community/google-signin', 'react-native-google-signin', 'react-native-fbsdk-next', 'react-native-fbsdk'];
const APPLE_LOGIN = ['@invertase/react-native-apple-authentication', 'expo-apple-authentication', 'react-native-apple-authentication'];

export function storeReviewRules(project, now = new Date()) {
  const root = project.root;
  const deps = project.deps || {};
  const findings = [];
  let source = null;
  const src = () => (source ??= appSource(root));

  if (SIGN_UP.test(src()) && !DELETION.test(src())) {
    findings.push({
      id: 'store-account-deletion',
      severity: 'medium',
      area: 'store',
      title: 'Users can create an account, but nothing in the app deletes it',
      detail: 'The code signs users up, and no account deletion was found (no deleteUser/deleteAccount call, no link to a deletion page). The App Store requires apps that support account creation to offer deletion within the app (guideline 5.1.1(v)), and Google Play requires an in-app path plus a web link, declared in the Data safety form. It is one of the most common rejection reasons. If deletion lives elsewhere (a web view, your support site), make sure it can be started from inside the app.',
      fix: { kind: 'store-rule', step: 'Add "Delete account" to the account or settings screen: it deletes the account and its data on the server (or starts that request), and publish the same as a web page for the Google Play Data safety form.' },
    });
  }

  const social = SOCIAL_LOGIN.filter((d) => deps[d]);
  const expoGoogle = !social.length && /expo-auth-session\/providers\/(?:google|facebook)/.test(src());
  const ios = fs.existsSync(path.join(root, 'ios')) || !!project.expoVersion;
  if ((social.length || expoGoogle) && ios && !APPLE_LOGIN.some((d) => deps[d]) && !/AppleAuthentication|appleAuth\b|signInWithApple|SignInWithApple|apple\.com/.test(src())) {
    const which = social.length ? social.join(', ') : 'Google/Facebook sign-in through expo-auth-session';
    findings.push({
      id: 'store-sign-in-with-apple',
      severity: 'medium',
      area: 'store',
      title: `Social login (${which}) without Sign in with Apple or an equivalent`,
      detail: 'App Store guideline 4.8: an app that uses a third-party login (Google, Facebook, …) for the user\'s primary account must also offer a login that limits data to name and email, lets users hide their email, and does not track for advertising. Sign in with Apple meets all three. Exceptions: the app only uses your company\'s own accounts, it is an education/enterprise app, or the third-party login only connects a service (for example Google Drive) rather than the account.',
      fix: { kind: 'store-rule', step: `Add Sign in with Apple next to ${which} on iOS (${project.expoVersion ? '`npx expo install expo-apple-authentication`' : '`@invertase/react-native-apple-authentication`'}), unless one of guideline 4.8's exceptions applies.` },
    });
  }
  for (const f of iosSdkPrivacyManifests(root)) findings.push(f);
  for (const f of iosSceneLifecycle(project, now)) findings.push(f);
  return findings;
}

// iOS SDKs from Apple's list in an old version without a privacy manifest (from ios/Podfile.lock).
// Apple refuses new apps that include them, and updates that add one, until the SDK ships a
// manifest. The pod that pulls it in (usually a React Native package) is named, since that is
// what the developer updates.
export function iosSdkPrivacyManifests(root) {
  let lock = '';
  try {
    lock = fs.readFileSync(path.join(root, 'ios', 'Podfile.lock'), 'utf8');
  } catch {
    return [];
  }
  const podsSection = (lock.split(/^DEPENDENCIES:/m)[0] || '').split(/^PODS:/m)[1] || '';
  const versions = {};
  const dependents = {}; // pod -> pods that depend on it
  let current = null;
  for (const line of podsSection.split('\n')) {
    const top = line.match(/^ {2}- "?([^\s/("]+)(?:\/[^\s("]+)? \(([^)]+)\)/);
    if (top) {
      current = top[1];
      if (!versions[current]) versions[current] = top[2];
      continue;
    }
    const dep = line.match(/^ {4}- "?([^\s/("]+)/);
    if (dep && current && dep[1] !== current) (dependents[dep[1]] ||= new Set()).add(current);
  }
  const cmp = (a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    return 0;
  };
  // The first pods up the chain that are not on Apple's list (RNFastImage, RNFBApp, …).
  // Climb to the React Native / Expo pods (RNFastImage, RNFBApp, EXImageLoader…): that is the
  // package the developer updates. Without one, the first pod off the list is named.
  const isRnPod = (p) => /^(?:RN|React|EX|Expo|lottie-react-native|react-native)/i.test(p);
  const owners = (pod, seen = new Set()) => {
    const rn = new Set();
    const other = new Set();
    for (const d of dependents[pod] || []) {
      if (seen.has(d)) continue;
      seen.add(d);
      if (isRnPod(d)) rn.add(d);
      else {
        const up = owners(d, seen);
        if (up.size) for (const o of up) rn.add(o);
        else if (!PRIVACY_SDKS[d]) other.add(d);
      }
    }
    return rn.size ? rn : other;
  };
  const old = [];
  for (const [pod, v] of Object.entries(versions)) {
    const sdk = PRIVACY_SDKS[pod];
    if (!sdk || !/^\d+(\.\d+)*$/.test(v)) continue;
    if (sdk.firstWithManifest === null || cmp(v, sdk.firstWithManifest) < 0) old.push({ pod, v, first: sdk.firstWithManifest, by: [...owners(pod)].slice(0, 3) });
  }
  if (!old.length) return [];
  const byOwner = [...new Set(old.flatMap((o) => o.by))];
  return [
    {
      id: 'ios-sdk-privacy-manifest',
      severity: 'medium',
      area: 'store',
      title: `${old.length} iOS SDK${old.length === 1 ? '' : 's'} on Apple's privacy manifest list ${old.length === 1 ? 'is' : 'are'} too old to have one (${old.slice(0, 3).map((o) => o.pod).join(', ')}${old.length > 3 ? ', …' : ''})`,
      detail: `${old.map((o) => `${o.pod} ${o.v} (${o.first ? `manifest from ${o.first}` : 'no release has one: replace it'}${o.by.length ? `, pulled in by ${o.by.join(', ')}` : ''})`).slice(0, 6).join('; ')}${old.length > 6 ? '; …' : ''}. Apple requires a privacy manifest for these SDKs: App Store Connect refuses a new app that includes them, or an update that adds one, until they ship it. Update the package that pulls each one in${byOwner.length ? ` (${byOwner.slice(0, 4).join(', ')})` : ''}, then run pod install.`,
      fix: { kind: 'store-rule', step: `Update ${byOwner.length ? byOwner.slice(0, 4).map((o) => `\`${o}\``).join(', ') : 'the packages that pull in'} so ${old.slice(0, 3).map((o) => `\`${o.pod}\``).join(', ')} reach a release with a privacy manifest (or replace those with none), then \`pod install\`.` },
    },
  ];
}

// The UIScene life cycle: required to launch when built with the iOS 27 SDK, which App Store
// Connect requires from April 2027 (see IOS_SDK_27). Bare projects: a scene manifest in
// Info.plist or application(_:configurationForConnecting:options:) in the app delegate.
function iosFiles(root, test, depth = 0, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (depth < 3 && !/^(Pods|build|DerivedData|\..*)$/.test(e.name) && !/Tests?$|Extension$|Widget|Intents|NotificationService|Share/i.test(e.name)) iosFiles(p, test, depth + 1, out);
    } else if (test(e.name)) out.push(p);
  }
  return out;
}

function sceneWindowLibs(project) {
  const deps = { ...(project.deps || {}), ...(project.devDeps || {}) };
  return Object.keys(SCENE_WINDOW_LIBS).filter((n) => deps[n]);
}

export function iosSceneLifecycle(project, now = new Date()) {
  const root = project.root;
  const iosDir = path.join(root, 'ios');
  const bare = fs.existsSync(iosDir);
  if (!bare && !(project.managed && project.expoVersion)) return [];
  const due = now.toISOString().slice(0, 10) >= IOS_SDK_27.from;
  const deadline = due
    ? 'App Store Connect only accepts apps built with the iOS 27 SDK (since April 2027)'
    : 'App Store Connect requires the iOS 27 SDK (Xcode 27) for uploads from April 2027';
  const why = `Apps built with the iOS 27 SDK that have not adopted the UIScene life cycle stop at launch ("UIScene life cycle is required for apps built with this SDK", Apple TN3187), and ${deadline}.`;
  const expoSdk = project.expoVersion ? Number(String(project.expoVersion).split('.')[0]) : null;
  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  };
  const libs = sceneWindowLibs(project);
  const libNote = libs.length
    ? ` After the move, ${libs.join(', ')} ${libs.length === 1 ? 'reads' : 'read'} the window from the app delegate and ${libs.length === 1 ? 'crashes' : 'crash'} if AppDelegate has no \`window\` property, as in the React Native 0.88 template: keep \`var window: UIWindow?\` in AppDelegate and set it from SceneDelegate until ${libs.length === 1 ? 'it is' : 'they are'} fixed.`
    : '';
  const finding = (fix, extra = '') => ({
    id: 'ios-uiscene-required',
    severity: due ? 'critical' : 'high',
    area: 'store',
    title: 'The iOS app will not launch once it is built with Xcode 27 (no UIScene life cycle)',
    detail: `${why}${extra} ${fix}${libNote}`,
    fix: { kind: 'store-rule', step: fix },
  });

  if (expoSdk !== null) {
    if (expoSdk >= IOS_SDK_27.expoDefaultSdk) return [];
    const config = ['app.json', 'app.config.js', 'app.config.ts'].map((f) => read(path.join(root, f))).join('\n');
    if (expoSdk === IOS_SDK_27.expoOptInSdk) {
      if (/enableSceneSupport["']?\s*:\s*true/.test(config)) return [];
      if (!bare || !/UIApplicationSceneManifest[\s\S]*?UISceneConfigurations/.test(iosFiles(iosDir, (n) => n === 'Info.plist').map(read).join(''))) {
        return [finding('On Expo SDK 57, update expo to 57.0.23+ and expo-build-properties to 57.0.20+, set `ios.enableSceneSupport: true` in its plugin options, then prebuild again (SDK 58 has it by default).')];
      }
      return [];
    }
    if (!bare) return [finding(`Expo SDK ${expoSdk} cannot adopt it: upgrade to SDK 57 and turn on \`ios.enableSceneSupport\` in expo-build-properties, or to SDK 58, where it is the default.`)];
  }

  const plists = iosFiles(iosDir, (n) => n === 'Info.plist');
  const delegates = iosFiles(iosDir, (n) => /^AppDelegate\.(swift|m|mm)$/.test(n));
  if (!plists.length || !delegates.length) return [];
  const delegateText = delegates.map(read).join('\n');
  // TN3187: a manifest without scene configurations does not count (Notesnook ships one with
  // only UIApplicationSupportsMultipleScenes).
  const adopted = plists.some((f) => /UIApplicationSceneManifest[\s\S]*?UISceneConfigurations/.test(read(f))) || /configurationForConnecting/.test(delegateText);
  const rn = project.rnVersion ? Number(String(project.rnVersion).split('.')[1]) : null;
  if (!adopted) {
    const fix = expoSdk !== null
      ? expoSdk === IOS_SDK_27.expoOptInSdk
        ? 'On Expo SDK 57, set `ios.enableSceneSupport: true` in expo-build-properties (expo 57.0.23+, expo-build-properties 57.0.20+) and run prebuild, or move to SDK 58.'
        : `Upgrade to Expo SDK 57 (with \`ios.enableSceneSupport\`) or SDK 58.`
      : rn !== null && rn < IOS_SDK_27.firstRnMinor
        ? `React Native 0.${IOS_SDK_27.firstRnMinor} is the first release whose template has scene support: upgrade, then add its SceneDelegate and the UIApplicationSceneManifest entry to Info.plist (React Native Upgrade Helper shows both).`
        : 'Add a SceneDelegate that starts React Native in the window scene and a UIApplicationSceneManifest entry in Info.plist, as in the React Native 0.88 template.';
    return [finding(fix, ' Building with Xcode 26 keeps the app working until then.')];
  }
  // Adopted: libraries that read the app delegate's window crash without one.
  const out = [];
  const hasWindow = /var\s+window\s*:\s*UIWindow|@property[^;]*UIWindow\s*\*\s*window\b|@synthesize\s+window/.test(delegateText);
  if (libs.length && !hasWindow) {
    out.push({
      id: 'ios-scene-delegate-window',
      severity: 'high',
      area: 'crash',
      title: `${libs.length === 1 ? `${libs[0]} crashes` : `${libs.length} libraries crash`}: AppDelegate has no window after the move to UIScene`,
      detail: `${libs.map((l) => `${l} (${SCENE_WINDOW_LIBS[l]})`).join('; ')} ${libs.length === 1 ? 'calls' : 'call'} [UIApplication sharedApplication].delegate.window from Objective-C. With the scene life cycle the window lives in SceneDelegate, and an AppDelegate without a window property throws "-[AppDelegate window]: unrecognized selector sent to instance", which ends the app. Reproduced on the React Native 0.88 template.`,
      fix: { kind: 'crash', step: 'Add `var window: UIWindow?` to AppDelegate and set it in SceneDelegate (`(UIApplication.shared.delegate as? AppDelegate)?.window = window`) until the libraries use RCTKeyWindow() / RCTPresentedViewController().' },
    });
  }
  // Adopted: URL and universal-link handlers must move to the scene delegate.
  const sources = iosFiles(iosDir, (n) => /\.(swift|m|mm)$/.test(n)).map(read).join('\n');
  const appHandlesUrls = /application\s*\([^)]*open\s+url|openURL:\s*\(NSURL|continueUserActivity|continue\s+userActivity|RCTLinkingManager\s+application|RCTLinkingManager\.application/.test(delegateText);
  const sceneHandlesUrls = /openURLContexts|scene\s*\([^)]*continue\s+userActivity|scene:\s*\(UIScene\s*\*\)\s*scene\s+continueUserActivity/.test(sources);
  if (appHandlesUrls && !sceneHandlesUrls) {
    out.push(
      {
        id: 'ios-uiscene-url-handlers',
        severity: 'high',
        area: 'crash',
        title: 'Deep links and universal links still go to AppDelegate after the move to UIScene',
        detail: 'With a scene manifest, UIKit delivers opened URLs and universal links to the scene delegate (scene(_:openURLContexts:), scene(_:continue:), and the connection options at launch), so the AppDelegate handlers no longer receive them: deep links, OAuth and payment redirects stop arriving. The React Native 0.88 template forwards them to RCTLinkingManager in SceneDelegate.',
        fix: { kind: 'store-rule', step: 'Implement scene(_:openURLContexts:) and scene(_:continue:) in SceneDelegate and forward them to RCTLinkingManager (and to any SDK that handled them in AppDelegate), and pass connectionOptions to startReactNative.' },
      },
    );
  }
  return out;
}
