# Native Android security source checks in 0.1.66

Run `npx nativekeel security . --html security.html --fail-on high`, or call MCP `security_audit`. The normal scan also includes these checks. They complement the existing JS/TS flows, TLS, secrets, storage, backend-rule and malware checks. They do not execute or build project code.

| Rule | Evidence required | Impact and prerequisites |
| --- | --- | --- |
| native-archive-path-write | A recognized ZIP/TAR stream entry name reaches FileOutputStream through a supported local File/path expression | An attacker-controlled archive may escape the destination and overwrite app-accessible files. A real untrusted archive and reachable extraction path are required. |
| native-intent-redirection | Incoming nested extra or parsed Intent URI reaches a launch in a matching explicitly exported Activity | Another app may influence a privileged launch or URI grants; supported OS protections and caller access must be verified. |
| native-intent-webview | Incoming string/data URL reaches a typed Android WebView loadUrl | A caller selects a page; credential theft or native bridge execution is not proven by loading alone. |
| native-intent-sql | Incoming string/data value is concatenated into query text sent to typed SQLiteDatabase rawQuery/execSQL | A reachable caller can alter local SQL; bound arguments are excluded. This is not backend SQL injection. |
| native-intent-file-read | Incoming string/data path reaches java.io.FileInputStream | A caller selects an app-accessible file to read. Disclosure additionally requires an outbound data path. |
| native-intent-file-write | Incoming string/data path reaches java.io.FileOutputStream | A caller selects an app-accessible path to create or overwrite. Sandbox permissions still apply. |

Findings include file/line evidence for the source, sink and manifest entry, an impact statement, attacker prerequisites, a local verification step and a proposed fix. Literal Gradle namespaces can supply a missing manifest package, with their own evidence location. No source snippets or credential values are copied into these findings.

## Conservative scope

These checks use a bounded dependency-free lexer and short local alias propagation. This is not a Java/Kotlin parser or compiler, a manifest merger, a call graph or a proof of exploitability. Recognized platform imports and receiver types reduce accidental matches. Java text blocks, Kotlin raw strings, comments and nested Kotlin comments cannot manufacture executable evidence.

Intent entry points require an exact class/module correlation with an explicitly exported declaration without a component/application permission. Implicit exports, manifest aliases, resource-based permissions, dynamic registration, runtime caller checks and merger overrides need separate review. The new incoming Intent flows currently cover Activities, not service/receiver callback flows.

Unknown transforms, compound mutation, ambiguous branches, cross-method flows, Kotlin interpolation and validators can stop analysis. A guarded/unresolved sink count records recognized candidates suppressed by this pass; it is not an exhaustive count of missed flows and does not certify those guards. Archive methods containing recognized canonical-path/validation indicators are conservatively left for manual review. More complex unsafe code can be missed.

Collection skips dependencies, build outputs, tests/examples, hidden directories, symlinks, files above 512 KiB and excessive nesting. Lexer token/delimiter limits bound adversarial source input. `securityReview.nativeCoverage` reports files, candidate files, matched entry points, method bodies, guarded/unresolved candidates and skipped inputs. A count of zero never means an app is safe.

## Platform mitigations

On Android 14+ with targetSdk 34+, java.util.zip rejects traversal ZIP names unless the app opts out. This does not establish protection on older supported devices or in other archive parsers. [Android behavior changes](https://developer.android.com/about/versions/14/behavior-changes-14#zip-path-traversal), [ZIP path traversal guidance](https://developer.android.com/privacy-and-security/risks/zip-path-traversal).

Android 16 introduces default Intent redirection launch protection. A source pattern is not proof that the launch bypasses this protection. Test older supported devices and explicit opt-outs. [Intent redirection guidance](https://developer.android.com/privacy-and-security/risks/intent-redirection).

URI validation must consider parsed scheme and exact host; native bridges and redirects need separate analysis. [Unsafe URI loading](https://developer.android.com/privacy-and-security/risks/unsafe-uri-loading), [SQL injection guidance](https://developer.android.com/privacy-and-security/risks/sql-injection), [path traversal guidance](https://developer.android.com/privacy-and-security/risks/path-traversal).

## Validation and remaining gaps

Positive and negative fixtures cover all six rules, aliases, fixed destinations, parameterized SQL, permissions, class/module mismatches, namespace evidence, guards, comments, strings and hostile nesting. CLI/MCP/SARIF/HTML/text integration is exercised. A harmless scratch-directory canary illustrates a traversal path and containment rejection; no corpus code was executed.

The full suite passes **270 tests**. The native pass was run read-only across **922 repositories**, with **zero new matching findings**. This is negative calibration, not proof of detection on real vulnerable native apps or a clean bill of health for these repositories. Manually reviewed canonical checks were not reported as vulnerabilities; a complex legacy extraction branch is outside the supported propagation scope. Synthetic fixtures are the positive detection evidence for this release.

Still unverified: arbitrary API ownership/IDOR, account A/B authorization, deployed Firebase/Supabase permissions, SSRF in backend services, iOS native input flows, release binary behavior, runtime hook/root attacks, supply-chain behavior not visible in source, and cross-process/cross-file paths. Existing checks cover selected configuration risks in some of these areas; this release adds no general pentest guarantee.
