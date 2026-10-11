# Security changes in 0.1.64

This release hardens the scanner and adds two conservative access-control checks. It does not claim that static analysis proves a deployed application secure or compromised.

## Reproduced defects and fixes

- A dependency name containing shell syntax appeared verbatim in a generated uninstall command. Project manifests now validate dependency maps/names before filesystem or command use; directory alternatives and patch-package names are validated too. This was a generated-command vulnerability, not execution inside NativeKeel.
- A package.json symlink inside an allowed MCP project returned metadata from outside the allowed roots. Scanner modules now share a request-local read adapter. Nested files, symlinks, parent lookups, node_modules and baseline scans are covered. Monorepo roots must be explicitly allowed. Skipped reads produce an incompleteness notice. This is not an OS sandbox against a concurrent local attacker.
- scan_project returned a malware warning that upgrade_plan and unchanged verify_upgrade results lost. The full scan's safety state is now preserved through scan/plan/explain/verify; malware yields a stop-only plan. `ok` retains its comparison meaning and is separate from `safety.blocked`.
- Sanitization diagnostics reflected a removed object key. They now use safe field paths. Manifest name objects are rejected; free-form project names are omitted from MCP output. This does not eliminate arbitrary prompt injection. No paid model evaluations were used.
- Home-directory access for plugin launches was an intentional design, not an undisclosed exploit. It is narrowed here: explicit `NATIVEKEEL_MCP_ROOTS` is required inside `PLUGIN_ROOT`. This is a configuration change.

## New application checks

- `firebase-auth-only-write`: a Firebase write/update/delete allow condition consisting only of `request.auth != null`. Owner/admin predicates, comments, public reads and create-only rules are excluded. Shared writable collections may be intentional.
- `supabase-policy-broad-write`: supported ordered SQL migrations enabling RLS while permitting unconditional SELECT and UPDATE/DELETE for anon or authenticated roles. Handles dropped policies and tables, disabled RLS, separate databases and restrictive policies conservatively. Unknown policy changes/dynamic SQL suppress a final-state claim. It does not resolve grants, API exposure or deployed schema state.

Both findings are medium severity and include file/line evidence, a source reference and prerequisites. `confidence: high` refers to the source pattern, not a confirmed production exploit. CLI, JSON, HTML, SARIF and MCP receive these checks through the normal analysis path.

## Verification and known limits

The complete suite passes: **232 tests, 0 failures**. The sample-report consistency check passes and package dry-run includes all new modules.

Five focused reproductions failed on the previous version and passed after the fixes. Negative fixtures cover scoped names, owner predicates, public SELECT, insert-only forms, restrictive policies, comments, strings, dynamic SQL and policy removal. MCP tests cover nested symlinks, explicitly allowed hoisted packages, existing malware during verification and redirected Git metadata.

The new checks were run read-only over 922 corpus Git repositories. Firebase produced two source matches, both manually inspected; Supabase produced none. All four existing malware examples still produce a stop warning. Of 865 root manifests, one was rejected for an actually malformed dependency name with an empty scope component. No corpus code was installed or executed; no live backend was probed and no external issue was filed.

This is a bounded extension, not a general IDOR/BOLA analyzer. Further work needs authorization-aware dataflow and local two-account emulator tests. Keep evidence separate from deployment assumptions; do not convert a missing pattern into a security guarantee.
