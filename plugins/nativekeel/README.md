# NativeKeel for Claude

NativeKeel checks React Native and Expo projects before you change them. With this plugin, Claude asks NativeKeel instead of guessing when you upgrade React Native or the Expo SDK, add or update a native library, prepare a Google Play or App Store release, review mobile security, or are about to install and run a project you did not write.

## What it adds

- **MCP server `nativekeel`** with read-only tools:
  - `scan_project`: upgrade blockers, New Architecture support, Google Play and App Store rules (target SDK, 16 KB page size, Xcode 27 UIScene life cycle, privacy manifests, account deletion), crash risks, OWASP MASVS security findings, leaked secrets and malware planted in the project. Each finding has a `file:line` reference and a fix.
  - `measure_bundle`: what the release JavaScript bundle is made of, measured from the source map a release build wrote: each package's share and packages bundled twice; with an older map, what changed between the two builds.
  - `upgrade_plan`: the order to upgrade in, with the reason for each phase and concrete steps.
  - `check_library`: latest version, New Architecture support, maintenance status and the version range that works with your React Native version.
  - `verify_upgrade`: after an upgrade, what got fixed and what is new compared with the last commit (or another git revision).
  - `explain_error`: what a build, launch, crash or store-review error means and the fix, and where the project is affected. The error text is matched locally and never sent anywhere.
- **Skill `react-native-health`**: tells Claude when to call these tools and how to read the results (critical and high findings first; stop if the project shows signs of malware).

## What it runs, reads and sends

- **Runs**: the open-source [nativekeel](https://www.npmjs.com/package/nativekeel) package from npm, with `node`. The plugin's `package-lock.json` pins one exact version with its integrity hash; Claude Code installs it when you install the plugin, without running install scripts, and the MCP server starts from that copy (`node ${CLAUDE_PLUGIN_ROOT}/node_modules/nativekeel/bin/nativekeel.js mcp`). The package has no dependencies and is published with npm provenance from [GitHub Actions](https://github.com/AlicanAkyol/nativekeel/actions). Requires Node.js 20 or newer.
- **Reads**: files in the project folder you ask about, only under the folder Claude Code was started in (plus folders listed in `NATIVEKEEL_MCP_ROOTS`). It never writes to the project, never runs code from the project, and never returns source code to Claude. The only programs it starts are git (`ls-files`; for `verify_upgrade` also `rev-parse` and `archive`), with every git option that could run a program switched off, and `tar`, which unpacks the committed version into a temporary folder outside the project that is deleted afterwards.
- **Sends**: package names and versions from `package.json` to `registry.npmjs.org` (latest versions and known vulnerabilities), `reactnative.directory` (New Architecture and maintenance status) and `unpkg.com` (the package versions an Expo SDK expects). No source code, file contents, secrets or personal data leave your machine, and there is no telemetry. Pass `offline: true` to skip these requests.

Text from the scanned repository is treated as data: control, zero-width and bidi characters are removed, and text that reads like instructions to an AI agent is replaced before it reaches Claude.

## Use

Install it, then ask as usual, for example "upgrade this app to the latest React Native" or "can I add react-native-reanimated 4 here?". You can also run it in a terminal: `npx nativekeel`.

More: [nativekeel.com/ai-agents](https://nativekeel.com/ai-agents) · [Security model](https://github.com/AlicanAkyol/nativekeel/blob/main/SECURITY.md) · License: MIT
