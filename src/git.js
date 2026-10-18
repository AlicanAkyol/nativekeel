import { spawnSync } from 'node:child_process';
import fs, { readPolicy, checkedPath } from './read-boundary.js';
import path from 'node:path';

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

// Git reads its own metadata outside our fs facade. Refuse redirected worktrees/object
// stores outside the request's roots before invoking it. Ordinary CLI scans are unaffected.
function gitPathExists(file) {
  try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
function permittedGit(root) {
  if (!readPolicy()) return true;
  try {
    let dir = path.resolve(root);
    while (true) {
      if (!readPolicy().roots.some(r => dir === r || dir.startsWith(r.endsWith(path.sep) ? r : r + path.sep))) return false;
      checkedPath(dir);
      const dot = path.join(dir, '.git');
      if (gitPathExists(dot)) {
        let gitdir = dot;
        if (fs.statSync(dot).isFile()) {
          const m = fs.readFileSync(dot, 'utf8').match(/^gitdir: (.+)\s*$/);
          if (!m) return false;
          gitdir = path.resolve(dir, m[1].trim());
        }
        checkedPath(gitdir);
        const commonFile = path.join(gitdir, 'commondir');
        const common = gitPathExists(commonFile) ? path.resolve(gitdir, fs.readFileSync(commonFile, 'utf8').trim()) : gitdir;
        checkedPath(common);
        for (const base of [gitdir, common]) {
          for (const name of ['objects', 'refs', 'packed-refs', 'HEAD', 'index', 'config', 'shallow']) {
            const file = path.join(base, name);
            if (gitPathExists(file)) checkedPath(file);
          }
          const alternates = path.join(base, 'objects/info/alternates');
          if (gitPathExists(alternates) && fs.readFileSync(alternates, 'utf8').trim()) return false;
        }
        return true;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  } catch { return false; }
}

// Runs git with the safe overrides. `args` never come from the scanned project.
function git(root, args, { encoding = 'utf8', maxBuffer = 64 * 1024 * 1024, input } = {}) {
  if (!permittedGit(root)) return { status: 1, stdout: null };
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return spawnSync('git', SAFE_CONFIG.flatMap((c) => ['-c', c]).concat(args), {
    cwd: root,
    encoding,
    maxBuffer,
    input,
    timeout: 60000,
    env: { ...env, ...GIT_ENV },
  });
}

// A folder unpacked from `git archive` has no .git, but every file in it is committed by
// definition. verify registers that list here so committed-file checks see the same files.
const trackedOverride = new Map();
export function setTrackedFiles(root, files) { trackedOverride.set(root, files); }
export function clearTrackedFiles(root) { trackedOverride.delete(root); }

export function gitLsFiles(root) {
  if (trackedOverride.has(root)) return trackedOverride.get(root);
  const res = git(root, ['ls-files', '-z']);
  if (res.status !== 0 || typeof res.stdout !== 'string') return null;
  // -z: names with newlines or quotes come through unmangled.
  const files = res.stdout.split('\0').filter(Boolean);
  const encrypted = encryptedFiles(root, files);
  return encrypted.size ? files.filter((f) => !encrypted.has(f)) : files;
}

// Files that git-crypt or transcrypt encrypt on commit (`filter=git-crypt` / `filter=crypt` in
// .gitattributes). The working copy is decrypted, but the repository and its history only hold
// ciphertext, so a key in them is not committed in the clear.
export function encryptedFiles(root, files) {
  // .gitattributes in the project, or above it when the project is a folder of a larger repo.
  const attrs = files.filter((f) => path.basename(f) === '.gitattributes').map((f) => path.join(root, f));
  for (let dir = path.resolve(root), i = 0; i < 6; i++, dir = path.dirname(dir)) {
    attrs.push(path.join(dir, '.gitattributes'));
    if (gitPathExists(path.join(dir, '.git')) || path.dirname(dir) === dir) break;
  }
  const uses = attrs.some((f) => {
    try {
      return /\bfilter=(?:git-crypt|crypt)\b/.test(fs.readFileSync(f, 'utf8'));
    } catch {
      return false;
    }
  });
  if (!uses) return new Set();
  const res = git(root, ['check-attr', '-z', '--stdin', 'filter'], { input: files.join('\0'), maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0 || typeof res.stdout !== 'string') return new Set();
  const out = new Set();
  const parts = res.stdout.split('\0');
  for (let i = 0; i + 2 < parts.length; i += 3) if (/^(?:git-crypt|crypt)$/.test(parts[i + 2])) out.add(parts[i]);
  return out;
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
