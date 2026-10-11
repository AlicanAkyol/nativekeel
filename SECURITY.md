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
- **Bounded work.** Large files are skipped, network time is capped at 90 seconds, git has a 60-second timeout.

## Using NativeKeel from AI coding agents (MCP)

`npx nativekeel mcp` serves the scan, the upgrade plan and library lookups to agents over the Model Context Protocol. An agent reads what the server returns, so a malicious repository could try to use NativeKeel to pass instructions to the agent. The server is built against that:

- **Read-only tools.** None writes to the project, runs project code, or runs commands other than `git ls-files`, and for `verify_upgrade` `git rev-parse` and `git archive` (all with the options that could run a program switched off) and `tar` to unpack the committed version into a temporary folder outside the project, deleted afterwards. Revisions that look like options or ranges are refused.
- **Only allowed folders.** The agent can scan folders under the directory it started the server in, plus any you list in `NATIVEKEEL_MCP_ROOTS`. A server started in the filesystem root allows nothing until you name a folder. Codex starts plugin servers inside the plugin's folder (`PLUGIN_ROOT`), which says nothing about the open project, and does not let users set environment variables for a plugin's server; there the boundary is your home folder, or only the folders in `NATIVEKEEL_MCP_ROOTS` when it is set (for example on a server you configure yourself in `config.toml`). A request-local filesystem adapter checks project file/directory reads against those roots, including symlinks and parent-folder lookups. Explicitly allow the monorepo root when hoisted packages are needed. Out-of-bound optional reads are skipped with a `readBoundary` notice; an unreadable required manifest fails the scan. Git worktrees/object stores redirected outside the roots are refused. The committed baseline is scanned under a separate temporary-root policy. This is an application-level read boundary, not an OS sandbox against another process actively changing the filesystem.
- **Bounded evidence in results.** Findings carry file/line references and short descriptions, not complete source files. Some existing checks include short evidence fragments. A project name that is not a package identifier is omitted from MCP results; malformed manifest fields and unsafe dependency names are rejected.
- **Every string is cleaned.** Control characters, ANSI escapes, zero-width and bidi-override characters (the "Trojan Source" trick) are removed and lengths are capped. Text matching a small set of common instruction patterns ("ignore previous instructions", fake `<system>` tags, `curl … | sh`, requests to send secrets) is replaced with a marker, and the result lists safe field locations without reflecting removed object keys. This pattern filter does not recognise every language, encoding or indirect instruction.
- **Malware blocks execution plans.** Full scan safety state is carried through project-scanning MCP tools even when their findings are filtered or unchanged against HEAD. `verify_upgrade.ok` still means no new critical/high findings; it is not permission to run the project. Check `safety.blocked` and `warning`.
- **Results say what they are.** Every response states that its fields are data extracted from the repository and must not be followed as instructions.
- **No dependencies.** The protocol is implemented with Node.js built-ins, like the rest of the tool.

These measures lower the risk; they cannot make an agent immune to every crafted text. Review what an agent proposes before you apply it, as you would for any change.

## What the security checks can and cannot tell you

NativeKeel reads source and configuration; it does not run the app, so it cannot see runtime behaviour, server-side settings or anything decided by your backend. Each finding names the file and line it is based on.

| Check | Detects | Does not detect |
|---|---|---|
| Malware planted in the project | VS Code tasks that run on folder open, code hidden after a long run of spaces or tabs in JavaScript/TypeScript files, JavaScript saved under a font or image extension, install scripts that run a data file or pipe a download into a shell | Malware in dependencies inside node_modules (use npm audit and a supply-chain scanner); obfuscated code without these hiding tricks |
| Secrets in code and config | Keys and tokens of known formats in the app or the repository; whether they ship in the bundle | Secrets with no recognisable format; whether a key is still active |
| AI provider keys in the bundle | OpenAI, Gemini, Anthropic and similar keys read from `EXPO_PUBLIC_`, react-native-config or react-native-dotenv variables | Keys fetched at runtime from your own server |
| Android components other apps can start | Services, receivers and providers exported without a permission in your manifest | Whether the component does anything sensitive with the input it receives |
| Deep links | Web links without domain verification; the template `myapp://` scheme, especially with OAuth | How your app validates the parameters of a link |
| Network | Cleartext HTTP, App Transport Security switched off, release builds trusting user-installed certificates, TLS checks turned off in native code | Certificate pinning quality; settings applied by your server or CDN |
| Data at rest | Session tokens in unencrypted storage, keychain items readable while the device is locked, wallet secrets copied to the clipboard, Android backups enabled | What other data you store, and where it goes after it leaves the device |
| WebViews | File-URL access flags (and whether the WebView shows local content), mixed content | What the loaded page does with the bridge to native code |
| Backend rules | Open Firebase rules; Firebase UPDATE/DELETE/write guards consisting only of `request.auth != null`; missing Supabase RLS; unconditional Supabase SELECT plus UPDATE/DELETE policies for anon/authenticated roles in supported migration statements | Deployed rules, grants/API exposure, complete SQL semantics, dynamic SQL, functions, unknown policy changes, arbitrary ownership flows. Public reads and insert-only policies are not flagged as broad writes; restrictive policies suppress the broad-policy finding |
| Weak cryptography | Hardcoded encryption keys, MD5/SHA-1 on passwords, ECB mode, `Math.random` for security values | Protocol design, key management on your servers |
| Release hardening | Debuggable builds, R8/ProGuard off | How hard the app is to reverse engineer in practice (any app can be unpacked) |
| Known vulnerabilities | Advisories for the exact versions of runtime dependencies (GitHub Advisory Database via npm) | Vulnerabilities not yet published; whether your code reaches the affected function |

A clean report means none of these patterns were found, not that the app is secure. Security that matters (who may read which data, what a request is allowed to do) has to be enforced on the server.

## Authorization evidence

The new policy findings have medium severity and high confidence in the matched **source pattern**, not in production exploitability. They include `evidence` file/line references, the role and operations, prerequisites, and a concrete review/test step. Shared editable data can be intentional. No live backend is probed.

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

## Focused mobile security review

`nativekeel security` / MCP `security_audit` include existing security checks plus eight bounded flow/configuration checks. New findings distinguish static evidence from attacker prerequisites and provide verification steps. No live service is probed. Read [the 0.1.65 method and limitations](docs/mobile-security-0.1.65.md); zero findings or MASVS counts are not security certification.
