# App improvement review

Introduced in 0.1.68. `improve` and `improve_app` combine existing checks into an actionable review. They do not run application code or add runtime measurement or new vulnerability detectors.

```sh
node bin/nativekeel.js improve /path/to/app --offline --out IMPROVE.md
node bin/nativekeel.js improve /path/to/app --offline --json
```

Without `--offline`, the existing scanner's package metadata lookups apply. The terminal prints plain text; `--out` saves escaped Markdown. CLI exit code 1 means malware blocked execution; 0 means a plan was generated, **not** that the app passed. Use `scan --fail-on` for the existing CI severity gate. `--out` writes JSON when combined with `--json`, otherwise Markdown. Existing scan/report commands are unchanged.

## Decision contract

An action identifies its original finding, domain, severity, confidence (or unspecified), available structured evidence, applicability prerequisites, expected effect, proposed change, validation and rollback. Existing checks without structured evidence remain visibly without it. Findings are candidates for review, not independently verified exploits or measured improvements. `measuredBenefit` is always null in this static plan.

Malware findings always take precedence, including when the output is truncated. They suppress proposed changes, execution-dependent prerequisites, validation and rollback for all actions. Otherwise ordering follows severity, then security, stability, accessibility, performance, delivery, upgrade and dependencies. This is transparent triage, not estimated business impact. At most 80 actions are returned; total and omitted counts refer to the full scan. Informational findings are excluded from actions.

The MCP tool uses the existing allowed-root, bounded-read and response sanitization wrapper. No server environment changes are needed. Markdown escapes repository-derived formatting. Sanitization reduces injection surfaces; it does not certify arbitrary agent behavior safe.

## Product scope and next modules

The intended product helps a developer decide what to fix, why it matters, and whether the change actually helped. Increasing the number of pattern matches alone is not sufficient.

| Module | Current evidence | Next implementation and acceptance gate |
| --- | --- | --- |
| Mobile security | Existing credential, transport, backend-rule, JS flow and Android native checks | Extend native iOS flows only with entry-point/protection modeling and exploitable/non-exploitable fixture pairs; preserve prerequisites and platform limits. |
| Runtime performance | Static candidates; supplied artifact comparison for a narrow import experiment | Import explicit release measurements for startup, frame timing and memory. Require matching device/build/scenario, repeat counts and variability; never convert bytes into FPS. |
| Dependency decisions | Conservative usage review and same-version import experiment | Resolve actual consumers and required features before alternatives. Include keeping the existing library; native and transitive costs count. |
| Reliability | Existing crash/compatibility patterns | Controlled tests for interrupted requests, retries, persistence migration and background/foreground recovery. Idempotency requires backend evidence. |
| Accessibility | Not evaluated | First static checks must resolve actual components and labels, including wrappers. Screen reader order, focus and dynamic type require device validation. |
| Network and energy | Not evaluated | Import request/retry/timing and energy observations for explicitly defined flows. A polling interval alone is not proof of excessive battery drain. |
| Release quality | Existing store/configuration checks | Inspect supplied signed release artifacts; distinguish source settings from shipped entitlements, manifests and dependencies. |
| Backend account isolation | Source-rule findings only | Explicitly authorized test tenant with two accounts and synthetic records; no production probing by default. |

Every new detector needs: stated threat or cost model, exact evidence provenance, positive and negative fixtures, bounds on unsupported syntax/configuration, and a reproducible verification procedure. Every measured recommendation needs an unchanged baseline and behavioral parity review. Unknowns stay unknown; no universal app quality or security score is inferred.

Next useful deliverable is a release-measurement import contract and parser with negative fixtures, followed by a trusted-device pilot when one exists. This does not require installing or executing unknown corpus applications. Until a pilot exists, synthetic tests establish parser behavior only, never real-world speed gains.

## Credential containment sources

AWS recommends immediately deactivating a compromised key: https://repost.aws/knowledge-center/manage-iam-access-keys-securely. Google distinguishes upload-key recovery from app signing identity: https://developer.android.com/studio/publish/app-signing. Dedicated test keys and commented credentials retain conditional guidance based on real use.
