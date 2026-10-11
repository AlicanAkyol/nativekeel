# Mobile security review in 0.1.65

`npx nativekeel security . --html security.html --fail-on high` reviews security findings without upgrade/store noise. The MCP equivalent is `security_audit`. The normal scan also runs the new checks. Existing secret, TLS, storage, Firebase/Supabase, dependency and malware checks remain available.

## New checks

| Rule | Source evidence | Required attacker access / limits |
| --- | --- | --- |
| credential-telemetry | Credential-named values reach an imported telemetry SDK, including short const aliases and nested payloads | A real credential must reach the SDK and survive redaction; a reader must obtain the payload. Names alone do not prove runtime values. |
| credential-url | Credential/password values enter the URL argument of fetch, axios or Linking.openURL | Access to a retained URL while the credential is valid. Public map tokens and request headers are excluded. |
| webview-message-eval | nativeEvent.data reaches eval/Function in a file using WebView messaging | Control over the loaded page or its scripts. JSON parsing and fixed scripts are not execution findings. |
| remote-code-eval | An awaited fetch response body reaches eval/Function | Control over the response/server/transport; not a claim that a real server is compromised. |
| sqlite-input-query | Traced TextInput, navigation, WebView or response data enters SQL text | Control over the traced value. Local SQLite risk, not a backend injection claim. Bound values and numeric conversions are excluded. |
| oauth-pkce-disabled | A used Expo AuthSession/AppAuth code-flow configuration explicitly sets usePKCE=false | Redirect interception and a server that accepts redemption. A backend-mediated exchange needs separate review. |
| oauth-implicit-flow | A used configuration requests token/id_token through a redirect | Redirect/token exposure. Recommend code flow with PKCE; do not infer an active account takeover. |
| android-fileprovider-broad | A manifest-referenced FileProvider resource shares the entire files/root directory | An unsafe sharing path or URI grant is also required. Cache/external-only sharing, unreferenced XML and narrow paths are excluded. |

New findings carry file/line `evidence`, an `attack` object (impact, prerequisite, validation, evidenceType), and a fix. Credentials and source snippets are not copied into these fields. SARIF uses the actual evidence location and related source locations instead of falling back to package.json.

## Reporting changes

Security findings are grouped by data exposure, account/backend access, code execution/input handling, and other risks. No green MASVS check marks or “groups checked” statement imply that absent findings certify security. Coverage states file counts, skipped inputs and the limitations of this pass. Offline scans explicitly leave online advisory checks unavailable.

## Method and scope

A dependency-free bounded lexer excludes comments, strings and regular-expression literals from executable evidence and preserves expressions inside templates. Short same-block const aliases are followed. Unknown transformations are not assumed to preserve dangerous input; this reduces false alarms but misses real flows. This is not a full JS/TS parser, control-flow graph, sanitizer verifier, cross-file call graph or runtime test. Complex syntax, spread configurations, mutable aliases and indirect SDK instances can be missed. Imported SDK recognition does not resolve the entire module graph.

New checks skip dependencies/build outputs/tests/examples, known backend/server/web folders, .web variants, symlinks, files above 512 KiB and nesting beyond their limits. A scan cannot certify deployed backend permissions, ownership checks across arbitrary API code, live Firebase rules, release binaries or multi-account isolation. Use authorized runtime/backend tests for those gaps.

## Validation

The complete suite passes: **252 tests, 0 failures**. Positive and negative fixtures exercise every new rule; integration tests cover CLI, MCP, HTML, Markdown, SARIF and coverage. A local synthetic VM canary demonstrates data becoming code through eval; JSON parsing leaves the canary untouched. A separate in-memory SQLite reproduction demonstrates an interpolated value changing the selected rows while a bound parameter does not. No corpus code is executed.

The read-only corpus pass covers 922 repositories. After excluding public map identifiers, server/web code and cache-only sharing, it yields 13 source matches in 11 repositories: 3 credential URLs, 4 implicit OAuth configurations, 6 broad private FileProvider roots. The matched source and manifest references were inspected. These are review candidates, not 13 confirmed exploitable applications; several grant/configuration choices can be intentional. Other new rules are validated by controlled fixtures and have no corpus match in this run.

## Primary references

- https://reactnative.dev/docs/security
- https://github.com/react-native-webview/react-native-webview/blob/master/docs/Guide.md#communicating-between-js-and-native
- https://docs.expo.dev/versions/latest/sdk/sqlite/#usage
- https://docs.expo.dev/versions/latest/sdk/auth-session/
- https://www.rfc-editor.org/rfc/rfc8252#section-8.1
- https://developer.android.com/privacy-and-security/risks/file-providers
