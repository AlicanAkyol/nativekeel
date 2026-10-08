# NativeKeel

Health check for React Native and Expo apps. One command, no install, no account:

```sh
npx nativekeel
```

**What's new in 0.1.38:** a removed React Native API that is only imported (never called) is a low "unused import", not a crash. **0.1.37:** five fixes from a real production app. Recent releases added a *Start here* list in every report, hacking risks mapped to OWASP MASVS, crash and performance checks. Every check is tuned on 650+ open-source React Native and Expo apps, with recently updated ones added every week, to keep false alarms out ([what we found in them](https://dev.to/keel_alican_akyol/we-scanned-470-open-source-react-native-apps-here-is-what-breaks-them-5072)). [All releases →](https://nativekeel.com/changelog)

```
Summary  4 critical · 5 high · 4 medium · 6 low
Security (OWASP MASVS)  crypto 1 · network 1  ·  7 groups checked

Start here
  1. Revoke the AWS access key ID in src/App.js:6 at the provider today.
  2. Set targetSdkVersion = 36 and compileSdkVersion = 36 in android/build.gradle.
  3. Move android:usesCleartextTraffic="true" to the debug manifest.
```

## What it checks

**Upgrade**
- **Is your React Native / Expo version still supported?** React Native supports the latest three minors; in Expo projects React Native moves with the SDK.
- **Can you upgrade at all?** The legacy architecture was removed in 0.82. If the New Architecture is off (it is off by default before 0.76), you are stuck at 0.81.
- **Which packages block the upgrade?** Native modules without New Architecture support (cross-checked with the package's own codegen spec), unmaintained or with no release in years, with verified alternatives and renamed packages. Library versions for each step come from the libraries' own compatibility tables.
- **What can you simply delete?** Installed packages that nothing imports, references natively, requires or patches.

**Store**
- **Will Google Play and the App Store accept your next build?** `targetSdk`, permissions Google Play restricts (photo/video, all files, background location, app installs, SMS), 16 KB memory pages (it also opens your built APK/AAB and checks every native library), the iOS privacy manifest and SDKs too old to have one, missing Info.plist usage descriptions, sign-up without account deletion, social login without Sign in with Apple, and release builds signed with the debug key.

**Crashes**
- **Will it crash at runtime?** packages off the versions your Expo SDK expects, release builds that still point at a development server, native libraries that need a newer React Native, Reanimated without its Babel plugin or `react-native-worklets`, mixed `@react-native-firebase/*` or `@react-navigation/*` majors, a second copy of React or React Native inside a dependency, Kotlin modules that cannot load through the New Architecture interop layer, AppDelegate setups that crash in Release, camera/photos/location access without the Info.plist text iOS requires, imports of APIs removed from React Native core (`AsyncStorage`, `Picker`, `ViewPropTypes`, …) or deprecated for removal (`ImageBackground`, `SafeAreaView`), and traps learned from real upgrades.

**Security, grouped by OWASP MASVS**
- **Secrets in the app or the repo:** AWS, Stripe, OpenAI, Anthropic, GitHub, Slack, SendGrid, Twilio, Shopify, Google OAuth and Supabase `service_role` keys, private keys, `.env` values compiled into the bundle, Expo `extra`/`EXPO_PUBLIC_`/`eas.json` secrets, signing keys and passwords.
- **Data on the device:** passwords that flow into crash reports, analytics, databases or plain AsyncStorage (followed through variables), auth tokens in unencrypted storage, Android backups that copy them.
- **Network:** TLS certificate checks turned off in native code, cleartext HTTP, `NSAllowsArbitraryLoads`, plain-HTTP API calls, user-installed CAs in release.
- **Backend rules:** Firebase Realtime Database, Firestore and Storage rules open to anyone or in test mode; Supabase tables created without row level security.
- **Cryptography:** hardcoded encryption keys, MD5/SHA-1 on passwords, ECB mode, `Math.random` for nonces and salts.
- **Platform:** WebViews that read local files or load HTTP into HTTPS, Android components any app can start, unverified deep links and the template `myapp://` URL scheme.
- **Dependencies and reverse engineering:** known vulnerabilities in the exact versions you ship (GitHub Advisory Database), source maps in the app, Hermes or R8 off.

These are static checks: they catch the common, detectable mistakes, not everything a penetration test of the running app and backend would.

**Performance**
- **Is it slow or heavy?** A FlatList inside a ScrollView (no virtualization), animations with `useNativeDriver: false`, `console.log` left in release builds, whole-library `lodash`/`moment` imports, images over 500 KB that the app requires.

## Usage

```sh
npx nativekeel [path]              # report
npx nativekeel plan --out UPGRADE.md   # step-by-step upgrade plan
npx nativekeel --html report.html  # shareable HTML report
npx nativekeel --markdown pr.md    # summary for a pull request comment
npx nativekeel --sarif nk.sarif    # GitHub code scanning
npx nativekeel --json              # machine-readable output
npx nativekeel --fail-on high      # exit 1 on high or critical (default: critical)
npx nativekeel --offline           # no network at all, local checks only
npx nativekeel --verbose           # list every outdated package
```

Everything is free. The scan exits with code `1` when it finds a critical issue, so it can gate CI.

### Upgrade plan

`nativekeel plan` turns the report into ordered work: stop leaks, set up a safety net of UI flows, fix crash risks, meet store deadlines, close security gaps, replace blocking packages, switch on the New Architecture at the right point, then upgrade React Native (or the Expo SDK) in small, reviewable hops with links to the Upgrade Helper diffs and the library versions each hop needs. Performance fixes and routine updates come last.

### GitHub Action

```yaml
# .github/workflows/nativekeel.yml
name: NativeKeel
on: [pull_request]
permissions:
  contents: read
  security-events: write   # only needed with sarif: true
jobs:
  health:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 20 }
      - run: npm ci
      - uses: AlicanAkyol/nativekeel@v0
        with:
          fail-on: critical
          baseline: .nativekeel-baseline.json   # optional
          sarif: true                           # findings inline in the PR
```

The report is added to the job summary. With a baseline, only findings that are new since the baseline fail the build:

```sh
npx nativekeel --save-baseline .nativekeel-baseline.json   # commit this file
```

### Reports for clients

Agencies can put their own name on the HTML report: `npx nativekeel plan --html plan.html --brand "Acme Mobile"`.

## Why you can run this on private code

- **Your code never leaves your machine.** The only requests are package-name lookups on npm and React Native Directory, and one request to npm's advisory endpoint with the names and exact versions of your runtime dependencies (what `npm audit` sends). In Expo projects without `node_modules`, one request to unpkg for the versions your Expo SDK expects (only the `expo` version is sent). `--offline` makes none; a test traps `fetch` to prove it.
- **Zero dependencies, no install scripts.** Only Node.js built-ins.
- **Read-only.** It never changes your project.
- **Secrets are always masked** in every output.
- **Verifiable releases.** Published with npm provenance from GitHub Actions: `npm audit signatures`.

Details and vulnerability reporting: [SECURITY.md](SECURITY.md).

## Need it done for you?

We do fixed-price React Native and Expo upgrades on a branch of your repository, delivered as a pull request with test builds. No calls needed. See https://nativekeel.com/#services.

## License

MIT
