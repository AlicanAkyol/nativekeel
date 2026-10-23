# NativeKeel

[![npm](https://img.shields.io/npm/v/nativekeel?color=0b5d55)](https://www.npmjs.com/package/nativekeel) [![Weekly downloads](https://img.shields.io/npm/dw/nativekeel)](https://www.npmjs.com/package/nativekeel) [![License: MIT](https://img.shields.io/npm/l/nativekeel)](LICENSE) [![React Native Directory](https://img.shields.io/badge/React_Native_Directory-tools-61dafb)](https://reactnative.directory/tools) [![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-4b5563)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.AlicanAkyol/nativekeel) [![GitHub Marketplace](https://img.shields.io/badge/GitHub_Marketplace-action-2ea44f?logo=github)](https://github.com/marketplace/actions/nativekeel) [![Awesome MCP Servers](https://img.shields.io/badge/awesome--mcp--servers-listed-fc60a8?logo=awesomelists&logoColor=white)](https://github.com/punkpeye/awesome-mcp-servers)

Health check for React Native and Expo apps. Will your app survive the next upgrade, pass the store and stay safe? One command, no install, no account:

```sh
npx nativekeel upgrade   # go/no-go for the newest React Native / Expo, with file and line
npx nativekeel           # full health check: upgrade, store rules, crashes, security, accessibility
```

<p align="center"><img src="https://nativekeel.com/demo-upgrade.svg" width="788" alt="npx nativekeel upgrade on a React Native 0.84 app: NOT READY, 3 blockers in its own code (StyleSheet.absoluteFillObject removed in 0.85 at src/components/Overlay.js:13, InteractionManager removed in 0.87 at src/screens/Feed.js:2, StatusBar translucent removed in 0.87 at src/App.js:8), each with the fix."></p>

No terminal handy? [Paste your package.json at nativekeel.com/check](https://nativekeel.com/check/): the same dependency checks and upgrade plan, run in your browser.

Works with **GitHub Actions** (a quality gate comment on every pull request), **[SonarQube](https://nativekeel.com/sonarqube)** (findings in your existing projects and quality gate) and **AI coding agents** (MCP server for Claude Code, Codex and Cursor). Several apps? `npx nativekeel fleet` puts them on [one page](https://nativekeel.com/teams).

**What's new in 0.1.125:** a guide for React Native 0.87's `StatusBar` `backgroundColor` / `translucent` removal (setter calls now throw), linked from the upgrade findings; NativeKeel is listed on awesome-mcp-servers. Recent releases added `npx nativekeel upgrade` (a go/no-go for the newest React Native / Expo), known malware anywhere in the lockfile's dependency tree, and detection of the actively exploited Metro dev-server flaw CVE-2025-11953. Every check is tuned on 1,100+ open-source React Native and Expo projects, with recently updated ones added every week, to keep false alarms out ([measured accuracy](https://nativekeel.com/accuracy)). [All releases →](https://nativekeel.com/changelog)

```
Summary  4 critical · 4 high · 6 medium · 6 low
Security (OWASP MASVS)  crypto 1 · network 1 · code 1  ·  7 finding categories; not a compliance verdict

Start here
  1. Revoke the AWS access key ID in src/App.js:6 at the provider today.
  2. Set targetSdkVersion = 36 and compileSdkVersion = 36 in android/build.gradle.
  3. Replace @react-native-community/push-notification-ios: no New Architecture support, unmaintained.
```

## Could someone steal data or abuse the app?

```sh
npx nativekeel security . --html security.html --fail-on high
```

Review secrets, credential leaks, backend access rules, unsafe code execution, transport and dependency risks in one report. New flow/configuration findings show where the input enters, where it is used, what an attacker would need, and how to verify the fix. `--offline` keeps the scan offline and skips online advisory checks. No source code is uploaded.

**Keys added at build time.** An `EXPO_PUBLIC_` value set in EAS or a CI secret never appears in the repository, so no source scan can see it, yet it ships in the app. NativeKeel also opens the built app and scans the JavaScript bundle inside it, plain JavaScript or Hermes bytecode: APKs and AABs under `android/app/build/outputs`, `eas build --local` results, committed bundles, and any APK, AAB or IPA you pass with `--artifact app.apk` (the GitHub Action's `artifact` input, after your build step).

This is source analysis, not a live attack or a security certificate. [Security checks and scope](https://nativekeel.com/security) · [Mobile flow details](docs/mobile-security-0.1.65.md) · [Native Android details](docs/native-security-0.1.66.md).

## What it checks

**Upgrade**
- **Is your React Native / Expo version still supported?** React Native supports the latest three minors; in Expo projects React Native moves with the SDK.
- **Can you upgrade at all?** The legacy architecture was removed in 0.82. If the New Architecture is off (it is off by default before 0.76), you are stuck at 0.81.
- **Which packages block the upgrade?** Native modules without New Architecture support (cross-checked with the package's own codegen spec), unmaintained or with no release in years, with verified alternatives and renamed packages. Library versions for each step come from the libraries' own compatibility tables.
- **Which packages might be unused?** Installed packages with no import, native reference, requirement or patch found. Listed for review, not automatic removal: dynamic and generated usage can hide from a static scan.

**Store**
- **Will Google Play and the App Store accept your next build?** `targetSdk`, permissions Google Play restricts (photo/video, all files, background location, app installs, SMS), 16 KB memory pages (it also opens your built APK/AAB and checks every native library), the iOS privacy manifest and SDKs too old to have one, missing Info.plist usage descriptions, sign-up without account deletion, social login without Sign in with Apple, and release builds signed with the debug key.

**Crashes**
- **Will it crash at runtime?** packages off the versions your Expo SDK expects, release builds that still point at a development server, native libraries that need a newer React Native, Reanimated without its Babel plugin or `react-native-worklets`, mixed `@react-native-firebase/*` or `@react-navigation/*` majors, a second copy of React or React Native inside a dependency, Kotlin modules that cannot load through the New Architecture interop layer, AppDelegate setups that crash in Release, camera/photos/location access without the Info.plist text iOS requires, imports of APIs removed from React Native core (`AsyncStorage`, `Picker`, `ViewPropTypes`, …) or deprecated for removal (`ImageBackground`, `SafeAreaView`), and traps learned from real upgrades.

**Security, grouped by OWASP MASVS**
- **Secrets in the app or the repo:** AWS, Stripe, OpenAI, Anthropic, GitHub, Slack, SendGrid, Twilio, Shopify, Google OAuth and Supabase `service_role` keys, private keys, `.env` values compiled into the bundle, Expo `extra`/`EXPO_PUBLIC_`/`eas.json` secrets, signing keys and passwords.
- **Data on the device:** iOS file sharing (`UIFileSharingEnabled`) that exposes an unencrypted MMKV, expo-sqlite or Realm database (they live in Documents by default on iOS), passwords that flow into crash reports, analytics, databases or plain AsyncStorage (followed through variables), auth tokens in unencrypted storage, Android backups that copy them.
- **Network:** TLS certificate checks turned off in native code, cleartext HTTP, `NSAllowsArbitraryLoads`, plain-HTTP API calls, user-installed CAs in release.
- **Backend rules:** Firebase Realtime Database, Firestore and Storage rules open to anyone or in test mode; Supabase tables created without row level security; sign-in-only Firebase write rules and unconditional Supabase UPDATE/DELETE policies without row ownership checks. Policy findings include file/line evidence and explain deployment/grant assumptions.
- **Authentication:** biometric prompts (Face ID, Touch ID, fingerprint) whose success is only a yes/no in JavaScript, with no secret bound to biometrics in the keychain/keystore, in JS or native code: the prompt guards the screen, not the data.
- **Cryptography:** hardcoded encryption keys, MD5/SHA-1 on passwords, ECB mode, `Math.random` for nonces and salts.
- **Platform:** WebViews that read local files or load HTTP into HTTPS, Android components any app can start, unverified deep links and the template `myapp://` URL scheme.
- **Dependencies and reverse engineering:** known vulnerabilities in the exact versions you ship (GitHub Advisory Database), source maps in the app, Hermes or R8 off.

These are static checks: they catch the common, detectable mistakes, not everything a penetration test of the running app and backend would.

**Performance**
- **What is your release bundle actually made of?** `npx nativekeel bundle` reads the source map a release build already wrote (Android: `android/app/build/generated/sourcemaps/react/release/`, Expo: `npx expo export --dump-sourcemap`) and measures how much of the shipped code is your app and each package, and which packages are bundled twice. `--base old.map` compares two builds: what was added, removed or grew. Nothing is built or run; the normal scan picks the map up too.
- **Where should you investigate performance?** Nested list patterns, JavaScript animation settings, source logging calls, root `lodash`/`moment` imports, referenced images over 500 KB, JSON over 300 KB imported into the JavaScript bundle (every language's translations, Lottie animations), and selector allocation patterns. Confirm the actual components, release output and runtime behavior before changing them; these checks do not measure frame rate, startup time or savings.
**Accessibility**
- **Can everyone use it?** Icon-only buttons with no accessibility label (VoiceOver and TalkBack say just "button"), buttons smaller than 44×44 with no `hitSlop`, text and placeholders whose color and background (both set in the code) fall below WCAG contrast, text fields with no label or placeholder, and text scaling turned off for the whole app. `Text.defaultProps` is flagged too: React 19 (React Native 0.78+) ignores it in JSX, so app-wide fonts and font-scaling limits silently stop applying. Only React Native's own touchables and inputs are checked; custom components, focus order and color contrast still need a test with a screen reader.

## App improvement review

```sh
npx nativekeel improve /path/to/app --offline
npx nativekeel improve /path/to/app --offline --out IMPROVE.md
```

Existing security, stability, performance, store and dependency findings become an ordered plan with reasons, applicability conditions, actions, verification and recovery. Exposed credentials get containment instructions. Apparently unused dependencies are review candidates: direct, transitive, dynamic, native and generated consumers must be considered before removal. Performance signals are not measurements.

Use `--json` for structured output or MCP `improve_app`. Malware findings block execution-dependent actions. Unknown runtime, backend, accessibility and reliability coverage stays explicit. This adds a decision layer over existing checks, not new vulnerability detectors. See [scope and next modules](docs/app-improvement.md).

## Usage

```sh
npx nativekeel [path]              # report
npx nativekeel plan --out UPGRADE.md   # step-by-step upgrade plan
npx nativekeel --html report.html  # shareable HTML report
npx nativekeel --markdown pr.md    # summary for a pull request comment
npx nativekeel --sarif nk.sarif    # GitHub code scanning
npx nativekeel --sonar nk-sonar.json  # SonarQube external issues
npx nativekeel --json              # machine-readable output
npx nativekeel --fail-on high      # exit 1 on high or critical (default: critical)
npx nativekeel --offline           # no network at all, local checks only
npx nativekeel --verbose           # list every outdated package
npx nativekeel fleet ~/clients     # every app in a folder side by side
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

The report is added to the job summary. To also keep one comment on each pull request up to date with what that pull request adds or fixes, give the job `pull-requests: write` and set `pr-comment: true`:

```yaml
permissions:
  contents: read
  pull-requests: write
# …
      - uses: AlicanAkyol/nativekeel@v0
        with:
          pr-comment: true
```

The comment compares the pull request with its base commit (no code runs) and is edited in place on every push, not repeated. Pull requests from forks get a read-only token, so they get the job summary only.

With a baseline, only findings that are new since the baseline fail the build:

```sh
npx nativekeel --save-baseline .nativekeel-baseline.json   # commit this file
```

### Use with AI coding agents (MCP)

Let Claude Code, Codex, Cursor, VS Code or any MCP client ask NativeKeel what is wrong with a project, how to upgrade it, and which version of a library works with your React Native version, instead of guessing. With it installed, the agent checks the project before it upgrades React Native or Expo, adds a native library, prepares a store release, or runs a project you did not write.

[![NativeKeel MCP server on Glama](https://glama.ai/mcp/servers/AlicanAkyol/nativekeel/badge)](https://glama.ai/mcp/servers/AlicanAkyol/nativekeel)

[![Install in Cursor](https://img.shields.io/badge/Cursor-Install_NativeKeel-black?logo=cursor)](https://cursor.com/install-mcp?name=nativekeel&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm5hdGl2ZWtlZWxAbGF0ZXN0IiwibWNwIl0sImVudiI6eyJOQVRJVkVLRUVMX01DUF9ST09UUyI6IiR7d29ya3NwYWNlRm9sZGVyfSJ9fQ%3D%3D) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_NativeKeel-0098FF?logo=visualstudiocode)](https://vscode.dev/redirect/mcp/install?name=nativekeel&config=%7B%22name%22%3A%22nativekeel%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22nativekeel%40latest%22%2C%22mcp%22%5D%2C%22env%22%3A%7B%22NATIVEKEEL_MCP_ROOTS%22%3A%22%24%7BworkspaceFolder%7D%22%7D%7D)

**Claude Code** (plugin: the MCP server plus a skill that tells Claude when to use it):

```bash
claude plugin marketplace add AlicanAkyol/nativekeel
claude plugin install nativekeel@nativekeel
```

Or the MCP server alone: `claude mcp add nativekeel -- npx -y nativekeel@latest mcp`

**Codex** (plugin: the MCP server plus the same skill):

```bash
codex plugin marketplace add AlicanAkyol/nativekeel
codex plugin add nativekeel@nativekeel
```

Or only the MCP server, in `~/.codex/config.toml`:

```toml
[mcp_servers.nativekeel]
command = "npx"
args = ["-y", "nativekeel@latest", "mcp"]
```

**Any other agent**, no MCP needed: add this line to your project's `AGENTS.md` or `CLAUDE.md`:

```markdown
Before upgrading React Native or Expo, adding a native library, or preparing a store release, run `npx -y nativekeel@latest --json` and fix the critical and high findings first.
```

Also listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.AlicanAkyol/nativekeel) as `io.github.AlicanAkyol/nativekeel`.

Tools: `scan_project` (findings with `file:line` and fixes), `measure_bundle` (what the release bundle is made of, from its source map), `upgrade_plan` (ordered steps), `check_library` (latest version, New Architecture support, maintenance, the range that works with a given React Native version, known traps) `explain_error` (what a build, launch, crash or store-review error means, the fix, and where this project is affected) and `verify_upgrade` (after an upgrade: what got fixed and what is new compared with the last commit). Without MCP: `npx nativekeel explain "<error>" --path .` and `npx nativekeel verify`. The server is read-only and only scans folders under the directory it was started in, plus `NATIVEKEEL_MCP_ROOTS` (set it when your client starts servers from another folder). Results omit source files and non-package project names. Common instruction-like patterns are filtered, but this is not a complete prompt-injection defense. Malware findings stop upgrade plans; `verify_upgrade.ok` means no new serious findings, while `safety.blocked` separately reports current malware. Servers started inside a plugin folder (Codex) use your home folder as the boundary, or only `NATIVEKEEL_MCP_ROOTS` when it is set. See [SECURITY.md](SECURITY.md#using-nativekeel-from-ai-coding-agents-mcp).

### Ratings and several apps at once

Every report rates six areas from A to E, the way SonarQube rates code: **Security, Store, Stability, Upgrade, Performance, Accessibility**. A means the scan found nothing in that area, B only low findings, C medium, D high, E at least one critical. A rating describes what the scan found, not a guarantee.

`npx nativekeel fleet [folder ...]` scans every React Native and Expo app under the folders you give it (client projects side by side, or all apps in a monorepo) and shows them in one table, worst first: versions, the six ratings, critical and high counts, and the store and end-of-support deadlines each app faces. `--html fleet.html` saves it as a page you can share, `--markdown` and `--json` work too, and `--fail-on` applies across all apps.

```sh
npx nativekeel fleet ~/clients --html fleet.html --brand "Acme Mobile"
npx nativekeel fleet ~/clients --json > fleet-2026-10.json     # keep this month's run
npx nativekeel fleet ~/clients --base fleet-2026-10.json       # next month: what changed per app
```

With `--base`, every app shows what changed since that run ("Security D→B, critical 2→0"), and new or removed apps are listed. `npx nativekeel compare before.json after.json` does the same for one app, ratings included.

Every app in a GitHub organization, monthly: copy [`examples/fleet-workflow.yml`](examples/fleet-workflow.yml) to `.github/workflows/` in any repository of the organization. On the 1st of each month it clones the repositories on the runner, scans them, compares with last month and writes the table to the run summary, with `fleet.html` and `fleet.json` kept as the run's artifact. Private repositories need a read-only `FLEET_TOKEN` secret; NativeKeel uploads nothing.

Already on SonarQube? `npx nativekeel --sonar nativekeel-sonar.json` writes the findings in SonarQube's generic issue format; pass it to the scanner with `-Dsonar.externalIssuesReportPaths=nativekeel-sonar.json` (or set `sonar: nativekeel-sonar.json` on the GitHub Action). Security findings arrive as vulnerabilities, store rules and crash risks as bugs, upgrade and other findings as code smells, each on its file and line. Tested on SonarQube Community Build 26.10. Details: [nativekeel.com/sonarqube](https://nativekeel.com/sonarqube).

In a pull request, the GitHub Action's comment (`pr-comment: true`) starts with a quality gate (passed when the change adds no critical or high finding) and the ratings, with what changed.

A `.nativekeel.json` next to `package.json` keeps the team's decisions in the repository: the gate level, findings the team has accepted, folders that are not part of the app (a web dashboard, a backend), each with a reason, which checks may fail the build (`gate`), and an `until` date on an accepted finding so it comes back for review: teams usually start by gating only the checks they have seen to be right in their code, and keep the rest as a report. Every finding in the report shows its id in brackets. A finding in a file no import reaches is labelled "in code no import reaches"; crash, performance and accessibility findings there are lowered, security findings keep their level, and a project that loads files by a computed path (require.context, import(variable)) gets no such label at all. `--fail-on` still wins. Ignored findings stay listed in the report, and malware warnings cannot be ignored.

```json
{
  "failOn": "high",
  "gate": ["secret:*", "backend-admin-in-bundle:*", "ci-*", "android-16kb-libs"],
  "ignore": [
    { "id": "flipper", "reason": "Removed in the 0.80 upgrade, sprint 42" },
    { "id": "a11y-small-touch-target*", "reason": "Design review in November", "until": "2026-12-01" }
  ],
  "exclude": [
    { "path": "tools/admin-web", "reason": "Internal web dashboard, not shipped in the app" }
  ]
}
```

**Team panel (closed beta).** With `--upload` (or the Action's `panel-token` input) and your team's token in `NATIVEKEEL_TOKEN`, each scan sends a summary to your team's page on nativekeel.com: app name, versions, ratings, finding titles. No source code and no finding details; never with `--offline`. [Live demo](https://nativekeel.com/panel-demo) · join the beta: hello@nativekeel.com.

Looking after many apps? Tell us what your team needs: hello@nativekeel.com

### Reports for clients

Agencies can put their own name on the HTML report: `npx nativekeel plan --html plan.html --brand "Acme Mobile"`.

## Why you can run this on private code

- **Your code never leaves your machine.** The only requests are package-name lookups on npm and React Native Directory, and one request to npm's advisory endpoint with the names and exact versions of your runtime dependencies (what `npm audit` sends). In Expo projects without `node_modules`, one request to unpkg for the versions your Expo SDK expects (only the `expo` version is sent). `--offline` makes none; a test traps `fetch` to prove it.
- **Zero dependencies, no install scripts.** Only Node.js built-ins.
- **Read-only.** It never changes your project.
- **Safe on untrusted projects.** It never runs project code, and a repository's own git config cannot make the scan run a command.
- **Secrets are always masked** in every output.
- **Verifiable releases.** Published with npm provenance from GitHub Actions: `npm audit signatures`.

Details and vulnerability reporting: [SECURITY.md](SECURITY.md). Wrong or missed finding? [Tell us](https://github.com/AlicanAkyol/nativekeel/issues/new?template=false-alarm.yml), no code needed.

## Expert help

The tool is free and stays free. If your team would rather hand an upgrade over, the maintainer takes on a few projects at a time: send your report to hello@nativekeel.com. [How it works](https://nativekeel.com/#help).

## License

MIT
