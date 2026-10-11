# Same-version Lodash import experiments

Unreleased prototype. It supports one narrow recipe: review Lodash 4 root imports, test a same-version per-method change, then compare supplied release bundle bytes. It does not rank libraries or prove an import can be changed safely. Other versions and package substitutions are outside this recipe.

## Discovery and review

The existing scan's `perf-heavy-imports` finding includes a `recommendation` object when a Lodash root import pattern is observed. CLI JSON and MCP `scan_project` expose the recipe, source location, reason, unknown benefit and required verification steps. No project files are modified or run. Comments, ordinary strings, type-only declarations (including inline named types), TypeScript import type queries and ambiguous/shadowed require references do not provide positive evidence. Dynamic import expressions and side-effect-only imports are intentionally outside this narrow recipe; omission is not proof that they are unused. The lexer is not a complete parser/resolver. A source pattern is not proof of runtime use or release inclusion.

Confirm the actual resolved package, aliases and build transforms. Check all consumers, including dependencies; examine chaining, mixins and dynamic method access. A transform might already narrow the import, or another consumer may keep the full module in the bundle. Keep the dependency installed. Review each affected method's behavior, including options, return values and timing/cancellation where relevant. Choose the existing implementation if the proposed change has no worthwhile benefit.

Lodash documents per-method entry points at https://lodash.com/. This supports a candidate mechanism, not a percentage saving in your app. Do not replace Lodash with lodash-es or another library solely from this signal.

## Prepare evidence from local files

`node bin/nativekeel.js prepare-imports settings.json > experiment.json` calculates artifact hashes and hashes of explicitly selected source files. Save the result beside the settings file so relative paths retain their meaning. It never runs source, build scripts or tests and never marks a review as passed. The generated experiment is intentionally incomparable until an actual review and behavior tests are recorded.

A settings file uses the same `schemaVersion`, `recipe`, `before/after.file` and `before/after.context` fields shown below. Instead of entering `sha256` and `sourceSnapshotHash` manually, give each side a source selection:

```json
{
  "source": {
    "root": "before-source",
    "files": ["src/App.tsx", "package.json", "package-lock.json", "metro.config.js"]
  }
}
```

Use `after-source` for the other side. All selected files must exist inside the corresponding source folder, itself inside the experiment folder. Use the same file coverage on both sides; include lockfiles/configs/other relevant inputs rather than hiding their changes. Filenames above are illustrative; use the files that actually exist in the project. Source content is not returned. No automatic complete-project inventory is claimed.

The output includes a sorted `sourceInventory`. `compare-imports` rereads the selected files, verifies their hashes and reports which selected paths changed. Stale evidence is rejected. Changed file membership, changed package/lock metadata, declaration files or recognized config filenames prevent a scoped import-only result even if the user marked tests as passed. Ordinary source edits still require human review: a hash difference does not identify the edit as import-only.

Preparation accepts settings up to 64 KiB, 1–5000 selected files per side, each up to 8 MiB and 32 MiB total per side. Generated/consumed experiment manifests are limited to 2 MiB. Artifact limits are unchanged. Both sides must use the same source evidence mode. Schema-v1 caller-hash-only experiments remain supported and explicitly labeled caller-reported.

Build settings and test outcomes remain caller-reported. The preparation tool does not derive a complete build-settings hash or prove the artifacts were built from the listed files. Keep supporting build logs/manifests and review actual input completeness before treating the result as evidence for a migration.

## Comparison

Build before and after versions in your own trusted environment using identical release settings. NativeKeel does not install dependencies, load build configs or execute either bundle. Place the two artifacts beside an experiment JSON file. Invoke the checkout's CLI:

```sh
node bin/nativekeel.js compare-imports /path/to/experiment.json --json
```

The normal scan, security review, plan and MCP tools remain available. No custom Codex server environment setting is needed. This command is CLI-only; the prototype adds no MCP file-import capability.

Use this JSON structure, replacing every `REPLACE_...` value with actual experiment data. The illustrative versions below are not upgrade recommendations. Hashes must be 64 lowercase hexadecimal SHA-256 characters; the placeholder template deliberately will not run as a measurement.

```json
{
  "schemaVersion": 1,
  "recipe": "lodash-import-scope",
  "before": {
    "file": "before.bundle",
    "sha256": "REPLACE_WITH_ACTUAL_ARTIFACT_SHA256",
    "sourceSnapshotHash": "REPLACE_WITH_BASELINE_SOURCE_MANIFEST_SHA256",
    "context": {
      "platform": "android",
      "mode": "release",
      "variant": "arm64-production",
      "artifactKind": "javascript-bundle",
      "reactNative": "0.80.0",
      "engine": "hermes-REPLACE_WITH_EXACT_VERSION",
      "bundler": "metro-REPLACE_WITH_EXACT_VERSION",
      "lodashVersion": "4.17.21",
      "buildSettingsHash": "REPLACE_WITH_BUILD_SETTINGS_MANIFEST_SHA256"
    }
  },
  "after": {
    "file": "after.bundle",
    "sha256": "REPLACE_WITH_ACTUAL_ARTIFACT_SHA256",
    "sourceSnapshotHash": "REPLACE_WITH_CHANGED_SOURCE_MANIFEST_SHA256",
    "context": {
      "platform": "android",
      "mode": "release",
      "variant": "arm64-production",
      "artifactKind": "javascript-bundle",
      "reactNative": "0.80.0",
      "engine": "hermes-REPLACE_WITH_EXACT_VERSION",
      "bundler": "metro-REPLACE_WITH_EXACT_VERSION",
      "lodashVersion": "4.17.21",
      "buildSettingsHash": "REPLACE_WITH_BUILD_SETTINGS_MANIFEST_SHA256"
    }
  },
  "verification": {
    "onlyImportChange": true,
    "samePackageVersion": true,
    "behaviorTests": "passed",
    "testScope": ["REPLACE_WITH_THE_ACTUAL_BEHAVIOR_TESTS_RUN"]
  }
}
```

Record the source snapshot as a deterministic manifest of relative file names and hashes of all relevant build inputs, including untracked/generated inputs. Commit plus dirty diff is insufficient. Record toolchain, lockfile, relevant flags/configuration and build conditions in the settings manifest. Do not include secret values. The preparation tool can create and later verify hashes for an explicit source selection. It does not establish that the selection includes every build input, or independently validate the build-settings manifest; retain supporting manifests with the experiment for review. Do not mark verification flags true until the corresponding review/tests were done.

Supported kinds are `javascript-bundle` and `hermes-bytecode`; they cannot be compared with each other. Android and iOS, different variants, versions, settings and engines also cannot be compared. Actual artifact hashes are recalculated locally. Relative artifact paths must remain inside the experiment folder, including symlink resolution. Artifacts must be non-empty regular files up to 64 MiB; experiment manifests up to 2 MiB. No archive extraction or source-map evaluation is performed. File identity and containment are rechecked after opening and before reading to detect a parent-directory symlink exchange.

## What the result means

`reported-context-size-reduction`: supplied artifact bytes decreased, under the caller-reported matching build conditions and passed tests. `no-size-reduction`: no reduction, or a size increase. `incomparable`: context or verification is insufficient; the percentage is omitted. The decision remains `requires-review` in every case.

Exit 0 means comparison completed, including equal size or growth; it is not approval to migrate. Exit 2 means invalid inputs or an incomparable experiment. There is no default CI regression gate in this prototype.

The tool measures the actual bytes and verifies their hashes. Completeness of the selected source snapshot, artifact format, build settings, patch scope and behavior results are caller-reported. When an inventory is present, the selected local file hashes are independently rechecked. Hashes do not establish authenticity, correct artifact classification or behavioral equivalence. The result does not prove causality independently of those reports.

Do not call the number installed app savings, compressed download savings, faster startup, smoother scrolling or reduced memory. Tests cover only their declared scope. This prototype has synthetic verification fixtures, not a measured customer-app performance claim. A real trusted-app pilot and producer integration are required before expanding the recipe or advertising automatic performance recommendations.

## Compatibility and handoff

Unused candidate finding IDs stay `unused:<package>`; their fix kind is now `review-dep`. Plans also accept historical `remove-dep` findings but convert them into review steps without an unconditional removal command. Upgrade advice is no longer suppressed for a candidate. Consumers of JSON should handle the new fix kind as a review task.

Installed dependency references cover regular, peer and optional declarations, nested node_modules and physically linked package trees, with cycle and package-count limits. This is conservative name-based protection, not a full locator/condition/reachability graph. Unreadable manifests, incomplete installs, denied reads or exhausted limits suppress unused candidates. Unknown dynamic/generated usage remains a documented limitation.

Release work is separate: update package/server versions only, changelog and README release text, regenerate sample reports and run release hygiene checks. Plugin versions remain CI-managed. Test the actual plugin stdio path with no custom server environment. Do not publish this development branch's provisional text as a released feature without completing those steps.
