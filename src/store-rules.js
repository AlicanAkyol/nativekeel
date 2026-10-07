import fs from 'node:fs';
import path from 'node:path';
import { PRIVACY_SDKS } from './privacy-sdks.js';

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

export function storeReviewRules(project) {
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
