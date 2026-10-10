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

export function gitLsFiles(root) {
  const args = SAFE_CONFIG.flatMap((c) => ['-c', c]).concat(['ls-files', '-z']);
  const res = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30000,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'false',
      SSH_ASKPASS: 'false',
      GIT_OPTIONAL_LOCKS: '0',
    },
  });
  if (res.status !== 0 || typeof res.stdout !== 'string') return null;
  // -z: names with newlines or quotes come through unmangled.
  return res.stdout.split('\0').filter(Boolean);
}
