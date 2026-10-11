# NativeKeel for Codex

NativeKeel checks React Native and Expo projects before you change them. This plugin adds the `nativekeel` MCP server (`scan_project`, `upgrade_plan`, `check_library`, `explain_error`, `verify_upgrade`) and a skill that tells Codex when to use it: upgrading React Native or the Expo SDK, adding a native library, fixing a build, launch or store-review error, preparing a release, or before running a project you did not write.

```
codex plugin marketplace add AlicanAkyol/nativekeel
codex plugin add nativekeel@nativekeel
```

**Runs** `npx -y nativekeel@<version> mcp`, the open-source [nativekeel](https://www.npmjs.com/package/nativekeel) package pinned to an exact version (no dependencies, npm provenance). **Reads** project files, never writes to the project, never runs project code, never returns source code. Codex starts plugin servers in the plugin folder and does not let users set environment variables for them, so the boundary is your home folder. To limit scans to one project, use the `config.toml` server below instead of the plugin and set `NATIVEKEEL_MCP_ROOTS` in its `env`. **Sends** only package names and versions to registry.npmjs.org, reactnative.directory and unpkg.com; no telemetry.

Server limited to one project, in `~/.codex/config.toml` (instead of the plugin):

```toml
[mcp_servers.nativekeel]
command = "npx"
args = ["-y", "nativekeel@latest", "mcp"]
env = { NATIVEKEEL_MCP_ROOTS = "/absolute/path/to/your/app" }
```

More: [nativekeel.com/ai-agents](https://nativekeel.com/ai-agents) · [Security model](https://github.com/AlicanAkyol/nativekeel/blob/main/SECURITY.md) · MIT
