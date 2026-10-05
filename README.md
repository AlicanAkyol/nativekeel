# NativeKeel

Health check for React Native and Expo apps. One command, no install, no account:

```sh
npx nativekeel
```

**What's new in 0.1.12:** hacking risks mapped to OWASP MASVS: open Firebase rules, TLS certificate checks turned off, hardcoded keys and weak crypto, tokens in plain storage, with a security overview in every report. **0.1.10:** every report opens with *Start here*, the three most urgent first steps; missing iOS permission texts (a crash and an App Review rejection) are caught. Recent releases added known vulnerabilities in the exact versions you ship, password leaks into logs and databases, unsafe WebViews, open Android components, plain-HTTP API calls and runtime crash risks. Tuned on 280+ open-source React Native and Expo apps to keep false alarms out. [All releases →](https://nativekeel.com/changelog)

It answers the questions that decide whether your app can still ship:

- **Is your React Native / Expo version still supported?** React Native supports the latest minor and the two before it.
- **Can you upgrade at all?** The legacy architecture was removed in 0.82. If the New Architecture is off, you are stuck at 0.81.
- **Which packages block the upgrade?** Native modules without New Architecture support, unmaintained or with no release in years, with known alternatives. Outdated "unmaintained" flags are cross-checked against the latest npm release.
- **What can you simply delete?** Packages that are installed but never imported, referenced natively or required by another package. Every one you remove is one you never upgrade.
- **Will the stores accept your next build?** Google Play `targetSdk` and 16 KB page size (it opens your built APK/AAB and checks the alignment of every native library), and the iOS privacy manifest.
- **Are secrets shipped inside your app?** AWS, Stripe, OpenAI, Anthropic, GitHub, Slack, SendGrid, Twilio, Shopify, Google OAuth keys, private keys and Supabase `service_role` keys (anon keys are fine), plus `.env` values that `react-native-config` or `EXPO_PUBLIC_` compile into the bundle. Server-side folders are reported separately.
- **Is transport security off?** Cleartext HTTP or `debuggable` in the release Android manifest, `NSAllowsArbitraryLoads` on iOS.
- **Do you ship known vulnerabilities?** Advisories from the GitHub Advisory Database for the exact versions in your lockfile or `node_modules`. Advisories that only affect Node.js servers are kept, at low severity.
- **Can someone break in?** Grouped by OWASP MASVS: Firebase Realtime Database/Firestore/Storage rules open to anyone (or in test mode), TLS certificate checks turned off in native code, hardcoded encryption keys, MD5/SHA-1 on passwords, ECB mode, `Math.random` for nonces and salts. These are static checks: they catch the common, detectable mistakes, not everything a penetration test of the running app would.
- **Can someone read your users' data?** Passwords that flow into crash reports, analytics, remote databases or plain AsyncStorage (followed through intermediate variables), WebViews that let page scripts read local files or load HTTP into HTTPS, Android backups that copy tokens, Android components any app can start, API calls over plain HTTP, auth tokens in unencrypted storage.
- **Will it crash at runtime?** Reanimated without its Babel plugin or `react-native-worklets`, mixed `@react-native-firebase/*` or `@react-navigation/*` majors, a second copy of React or React Native inside a dependency, Kotlin modules that cannot load through the New Architecture interop layer, AppDelegate setups that crash in Release, camera/photos/location access without the Info.plist description iOS requires.
- **Leftovers from old templates?** Flipper, JavaScriptCore instead of Hermes.

```
✖ CRITICAL React Native 0.77.1 is no longer supported
           Latest is 0.87.1. You are 10 minor versions behind; only the latest 3 minors receive fixes.
✖ CRITICAL New Architecture is disabled (android + ios)
           The legacy architecture was removed in 0.82. This app cannot upgrade past 0.81 until it migrates.
✖ CRITICAL AWS secret access key shipped inside the app (src/aws.js:4)
           Value wJal…EY. Anyone who downloads the app can extract it. Revoke it now, then move the call to a server.
▲ HIGH     react-native-fast-image: no New Architecture support, unmaintained
           Likely upgrade blocker. Alternatives: expo-image.
```

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

`nativekeel plan` turns the report into ordered work: stop leaks first, replace blocking packages, switch on the New Architecture on your current version, then upgrade React Native in small, reviewable hops with links to the Upgrade Helper diffs.

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

- **Your code never leaves your machine.** The only requests are package-name lookups on npm and React Native Directory, and one request to npm's advisory endpoint with the names and exact versions of your runtime dependencies (what `npm audit` sends). `--offline` makes none; a test traps `fetch` to prove it.
- **Zero dependencies, no install scripts.** Only Node.js built-ins.
- **Read-only.** It never changes your project.
- **Secrets are always masked** in every output.
- **Verifiable releases.** Published with npm provenance from GitHub Actions: `npm audit signatures`.

Details and vulnerability reporting: [SECURITY.md](SECURITY.md).

## Need it done for you?

We do fixed-price React Native and Expo upgrades on a branch of your repository, delivered as a pull request with test builds. No calls needed. See https://nativekeel.com/#services.

## License

MIT
