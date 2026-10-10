# Security

NativeKeel reads your app's source code, so it has to be boring and inspectable.

## What the tool does and does not do

- **Runs locally.** It never uploads source code, reports or secrets.
- **Network:** package-name and version lookups on `registry.npmjs.org` and `reactnative.directory`; one request to npm's advisory endpoint with the names and exact versions of runtime dependencies (what `npm audit` sends); in Expo projects without `node_modules`, one request to `unpkg.com` for the versions the Expo SDK expects (only the `expo` version is sent). Source code is never sent. A scan spends at most 90 seconds on the network. `--offline` makes no requests at all; a test in this repository traps `fetch` to prove it.
- **No dependencies.** Only Node.js built-ins, so there is no third-party supply chain to compromise.
- **No install scripts.** Nothing runs when the package is installed.
- **Secret values are masked** in every output format (terminal, HTML, JSON, plan). Only the first four and last two characters are shown.
- **Read-only.** It never modifies your project. The only files it writes are the ones you ask for with `--html`, `--out` or `--save-baseline`.
- **Provenance.** Releases are published from GitHub Actions with npm provenance, so you can verify that the package on npm was built from this repository: `npm audit signatures`.

## The scanned project is untrusted input

A repository can contain anything, including files written to attack the tools that read it. NativeKeel treats the project it scans as hostile:

- **Project code never runs.** No `npm install`, no package scripts, no Gradle, CocoaPods or Metro. Files are read and parsed as text.
- **git cannot be turned against you.** The scan runs `git ls-files` to know which files are committed. A repository's own `.git/config` can make git run a program (`core.fsmonitor` does this even for `ls-files`; checked with git 2.50.1). NativeKeel overrides every such option on the command line (`core.fsmonitor`, `core.hooksPath`, `core.sshCommand`, pager, editor, credential helpers) and ignores your global and system git config. A test in this repository plants an `fsmonitor` command and fails if it runs.
- **Bounded work.** Large files are skipped, network time is capped at 90 seconds, git has a 30-second timeout.

## Using NativeKeel from AI coding agents (MCP)

`npx nativekeel mcp` serves the scan, the upgrade plan and library lookups to agents over the Model Context Protocol. An agent reads what the server returns, so a malicious repository could try to use NativeKeel to pass instructions to the agent. The server is built against that:

- **Read-only tools.** None writes files, runs commands or executes project code.
- **Only allowed folders.** The agent can scan folders under the directory it started the server in, plus any you list in `NATIVEKEEL_MCP_ROOTS`. Paths are resolved with symlinks followed, so a link inside the project cannot point the scan elsewhere.
- **No source code in results.** Findings carry `file:line` references, never file contents.
- **Every string is cleaned.** Control characters, ANSI escapes, zero-width and bidi-override characters (the "Trojan Source" trick) are removed and lengths are capped. Text that reads like instructions to an AI agent ("ignore previous instructions", fake `<system>` tags, `curl … | sh`, requests to send secrets) is replaced with a marker, and the result lists where it was removed.
- **Results say what they are.** Every response states that its fields are data extracted from the repository and must not be followed as instructions.
- **No dependencies.** The protocol is implemented with Node.js built-ins, like the rest of the tool.

These measures lower the risk; they cannot make an agent immune to every crafted text. Review what an agent proposes before you apply it, as you would for any change.

## What the security checks can and cannot tell you

NativeKeel reads source and configuration; it does not run the app, so it cannot see runtime behaviour, server-side settings or anything decided by your backend. Each finding names the file and line it is based on.

| Check | Detects | Does not detect |
|---|---|---|
| Secrets in code and config | Keys and tokens of known formats in the app or the repository; whether they ship in the bundle | Secrets with no recognisable format; whether a key is still active |
| AI provider keys in the bundle | OpenAI, Gemini, Anthropic and similar keys read from `EXPO_PUBLIC_`, react-native-config or react-native-dotenv variables | Keys fetched at runtime from your own server |
| Android components other apps can start | Services, receivers and providers exported without a permission in your manifest | Whether the component does anything sensitive with the input it receives |
| Deep links | Web links without domain verification; the template `myapp://` scheme, especially with OAuth | How your app validates the parameters of a link |
| Network | Cleartext HTTP, App Transport Security switched off, release builds trusting user-installed certificates, TLS checks turned off in native code | Certificate pinning quality; settings applied by your server or CDN |
| Data at rest | Session tokens in unencrypted storage, wallet secrets copied to the clipboard, Android backups enabled | What other data you store, and where it goes after it leaves the device |
| WebViews | File-URL access flags (and whether the WebView shows local content), mixed content | What the loaded page does with the bridge to native code |
| Backend rules | Firestore rules open to anyone, Supabase tables without row level security (from files in the repository) | Rules deployed from somewhere else; what a policy allows in detail |
| Weak cryptography | Hardcoded encryption keys, MD5/SHA-1 on passwords, ECB mode, `Math.random` for security values | Protocol design, key management on your servers |
| Release hardening | Debuggable builds, R8/ProGuard off | How hard the app is to reverse engineer in practice (any app can be unpacked) |
| Known vulnerabilities | Advisories for the exact versions of runtime dependencies (GitHub Advisory Database via npm) | Vulnerabilities not yet published; whether your code reaches the affected function |

A clean report means none of these patterns were found, not that the app is secure. Security that matters (who may read which data, what a request is allowed to do) has to be enforced on the server.

## Report format

`--json` and `--sarif` give machine-readable results. Each finding has:

- `id`: the check and, where it applies, the file or package (`secret:openai-key:src/api.ts`)
- `severity`: `critical`, `high`, `medium`, `low` or `info`
- `area`: `security`, `secret`, `store`, `crash`, `dependency`, …
- `masvs`: the OWASP MASVS group for security findings
- `title`: what was found, with `file:line` when it comes from a file
- `detail`: why it matters and what the check is based on (with sources for store and platform rules)
- `fix`: the concrete step

Secret values appear only masked. SARIF output carries the same information for GitHub code scanning.

## Reporting a vulnerability

Email **hello@nativekeel.com** with the subject `SECURITY`. Please do not open a public issue. You will get a reply within two business days, and a fix or a plan within seven.
