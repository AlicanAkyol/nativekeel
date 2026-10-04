# Security

NativeKeel reads your app's source code, so it has to be boring and inspectable.

## What the tool does and does not do

- **Runs locally.** It never uploads source code, reports or secrets.
- **Network:** only package-name lookups on `registry.npmjs.org` and `reactnative.directory`. `--offline` makes no requests at all; a test in this repository traps `fetch` to prove it.
- **No dependencies.** Only Node.js built-ins, so there is no third-party supply chain to compromise.
- **No install scripts.** Nothing runs when the package is installed.
- **Secret values are masked** in every output format (terminal, HTML, JSON, plan). Only the first four and last two characters are shown.
- **Read-only.** It never modifies your project. The only files it writes are the ones you ask for with `--html`, `--out` or `--save-baseline`.
- **Provenance.** Releases are published from GitHub Actions with npm provenance, so you can verify that the package on npm was built from this repository: `npm audit signatures`.

## Reporting a vulnerability

Email **hello@nativekeel.com** with the subject `SECURITY`. Please do not open a public issue. You will get a reply within two business days, and a fix or a plan within seven.
