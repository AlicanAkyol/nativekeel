import { spawnSync } from 'node:child_process';

// The scanned project is untrusted input. Its .git/config can set options that make git run
// commands: core.fsmonitor runs on plain `git ls-files` (checked with git 2.50.1), so scanning
// a folder that came with its own .git directory (a zip sent for an audit, a repository an AI
// agent points the scan at) could execute code. Command-line `-c` settings win over the
// repository's config, so these switch off every option that runs a program, and the
// environment keeps the user's global/system config and credential prompts out of it.
const SAFE_CONFIG = [
  'core.fsmonitor=false',
  'core.hooksPath=/dev/null',
  'core.sshCommand=false',
  'core.pager=cat',
  'core.editor=false',
  'core.askPass=false',
  'credential.helper=',
  'diff.external=',
  'protocol.allow=never',
];

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'false',
  SSH_ASKPASS: 'false',
  GIT_OPTIONAL_LOCKS: '0',
};

// Runs git with the safe overrides. `args` never come from the scanned project.
function git(root, args, { encoding = 'utf8', maxBuffer = 64 * 1024 * 1024 } = {}) {
  return spawnSync('git', SAFE_CONFIG.flatMap((c) => ['-c', c]).concat(args), {
    cwd: root,
    encoding,
    maxBuffer,
    timeout: 60000,
    env: { ...process.env, ...GIT_ENV },
  });
}

export function gitLsFiles(root) {
  const res = git(root, ['ls-files', '-z']);
  if (res.status !== 0 || typeof res.stdout !== 'string') return null;
  // -z: names with newlines or quotes come through unmangled.
  return res.stdout.split('\0').filter(Boolean);
}

// A revision name a person or agent typed (HEAD, HEAD~1, main, v1.2.0, a SHA). Anything that
// could be read as an option or a pathspec is refused.
export const SAFE_REF = /^(?!-)[A-Za-z0-9._/~^@{}-]{1,200}$/;

// The project folder as committed at `ref`, as a tar archive (Buffer), or an error message.
// `git archive` only reads the object database: no hooks, filters or checkout run.
export function gitArchive(root, ref) {
  if (!SAFE_REF.test(ref) || ref.includes('..') || ref.includes('@{-')) return { error: `not a revision: ${ref}` };
  const prefix = git(root, ['rev-parse', '--show-prefix']);
  if (prefix.status !== 0) return { error: 'not a git repository' };
  const commit = git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  if (commit.status !== 0) return { error: `unknown revision: ${ref}` };
  const sha = commit.stdout.trim();
  const sub = prefix.stdout.trim().replace(/\/$/, '');
  const res = git(root, ['archive', '--format=tar', sub ? `${sha}:${sub}` : sha], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
  if (res.status !== 0 || !res.stdout) return { error: res.error && res.error.code === 'ENOBUFS' ? 'the committed project is larger than 512 MB' : 'git archive failed' };
  return { tar: res.stdout, sha };
}
