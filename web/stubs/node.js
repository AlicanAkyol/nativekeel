// Node built-ins the browser build never reaches with real work: no git, no processes, no temp files.
export const spawnSync = () => ({ status: 1, stdout: '', stderr: '' });
export const execFileSync = () => { throw new Error('not available in the browser'); };
export const tmpdir = () => '/tmp';
export const homedir = () => '/';
export const createHash = () => ({ update() { return this; }, digest: () => '' });
export const gunzipSync = (b) => b;
export const inflateRawSync = (b) => b;
export class AsyncLocalStorage { getStore() { return undefined; } run(_s, fn) { return fn(); } }
export const fileURLToPath = (u) => String(u).replace(/^file:\/\//, '');
export const promisify = (f) => f;
const stub = { spawnSync, execFileSync, tmpdir, homedir, createHash, gunzipSync, inflateRawSync, AsyncLocalStorage, fileURLToPath, promisify };
export default stub;
