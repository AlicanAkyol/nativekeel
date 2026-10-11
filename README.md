# NativeKeel

Health check for React Native and Expo apps. One command, no install, no account:

```sh
npx nativekeel
```

**What's new in 0.1.64:** stricter MCP file boundaries, validated dependency names, and malware stop warnings preserved across scan, plan, error and verify tools. New checks flag Firebase writes guarded only by sign-in and unconditional Supabase row policies. These are source findings, not proof of deployed exploitability. Plugin servers now require explicit `NATIVEKEEL_MCP_ROOTS`. **0.1.63:** a Codex plugin (`codex plugin marketplace add AlicanAkyol/nativekeel`) with the MCP server and the same skill as the Claude Code plugin. **0.1.62:** `npx nativekeel verify` and the `verify_upgrade` MCP tool: after an upgrade, what got fixed and what is new compared with the last commit; exits 1 on new critical or high findings. **0.1.61:** `npx nativekeel explain "<error>"` and the `explain_error` MCP tool: what a build, launch, crash or store-review error means, the fix, and where your project is affected. **0.1.59:** the upgrade plan lists what changes in the next React Native and Expo versions in your own code. **0.1.57:** a Claude Code plugin (`claude plugin marketplace add AlicanAkyol/nativekeel`) that adds the MCP server and tells Claude when to use it, one-click install for Cursor and VS Code. **0.1.56:** warns before you run a project with planted malware (a VS Code task that runs on folder open, code hidden after a long run of spaces in babel.config.js, JavaScript disguised as a font), the trick behind fake job tests sent to developers. Found in 4 open-source repositories during our weekly scan. **0.1.55:** listed in the official MCP Registry (`io.github.AlicanAkyol/nativekeel`). Recent releases added a *Start here* list in every report, hacking risks mapped to OWASP MASVS, crash and performance checks. Every check is tuned on 850+ open-source React Native and Expo apps, with recently updated ones added every week, to keep false alarms out ([what we found in them](https://dev.to/keel_alican_akyol/we-scanned-470-open-source-react-native-apps-here-is-what-breaks-them-5072)). [All releases →](https://nativekeel.com/changelog)

```
Summary  4 critical · 5 high · 4 medium · 7 low
Security (OWASP MASVS)  crypto 1 · network 1 · code 1  ·  7 groups checked

Start here
  1. Revoke the AWS access key ID in src/App.js:6 at the provider today.
  2. Set targetSdkVersion = 36 and compileSdkVersion = 36 in android/build.gradle.
  3. Replace react-native-fast-image: no New Architecture support.
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
- **Backend rules:** Firebase Realtime Database, Firestore and Storage rules open to anyone or in test mode; Supabase tables created without row level security; sign-in-only Firebase write rules and unconditional Supabase UPDATE/DELETE policies without row ownership checks. Policy findings include file/line evidence and explain deployment/grant assumptions.
- **Cryptography:** hardcoded encryption keys, MD5/SHA-1 on passwords, ECB mode, `Math.random` for nonces and salts.
- **Platform:** WebViews that read local files or load HTTP into HTTPS, Android components any app can start, unverified deep links and the template `myapp://` URL scheme.
- **Dependencies and reverse engineering:** known vulnerabilities in the exact versions you ship (GitHub Advisory Database), source maps in the app, Hermes or R8 off.

These are static checks: they catch the common, detectable mistakes, not everything a penetration test of the running app and backend would.

**Performance**
- **Is it slow or heavy?** A FlatList inside a ScrollView (no virtualization), animations with `useNativeDriver: false`, `console.log` left in release builds, whole-library `lodash`/`moment` imports, images over 500 KB that the app requires, Redux selectors that re-render on every store update.

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

### Use with AI coding agents (MCP)

Let Claude Code, Codex, Cursor, VS Code or any MCP client ask NativeKeel what is wrong with a project, how to upgrade it, and which version of a library works with your React Native version, instead of guessing. With it installed, the agent checks the project before it upgrades React Native or Expo, adds a native library, prepares a store release, or runs a project you did not write.

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

Tools: `scan_project` (findings with `file:line` and fixes), `upgrade_plan` (ordered steps), `check_library` (latest version, New Architecture support, maintenance, the range that works with a given React Native version, known traps) `explain_error` (what a build, launch, crash or store-review error means, the fix, and where this project is affected) and `verify_upgrade` (after an upgrade: what got fixed and what is new compared with the last commit). Without MCP: `npx nativekeel explain "<error>" --path .` and `npx nativekeel verify`. The server is read-only and only scans folders under the directory it was started in, plus `NATIVEKEEL_MCP_ROOTS` (set it when your client starts servers from another folder). Results omit source files and non-package project names. Common instruction-like patterns are filtered, but this is not a complete prompt-injection defense. Malware findings stop upgrade plans; `verify_upgrade.ok` means no new serious findings, while `safety.blocked` separately reports current malware. Servers started inside a plugin folder require explicit project roots; they no longer default to the home folder. See [SECURITY.md](SECURITY.md#using-nativekeel-from-ai-coding-agents-mcp).

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

## Need it done for you?

We do fixed-price React Native and Expo upgrades on a branch of your repository, delivered as a pull request with test builds. No calls needed. See https://nativekeel.com/#services.

## License

MIT
