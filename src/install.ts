// Install the code, Python environments and weights this host serves, as pinned in the manifest.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { modelRoot, places, read, served } from './config';
import {
  type Checkout,
  type Component,
  manifest,
  type Name,
  paths,
  type Release,
  type Weights,
} from './manifest';

const repo = resolve(import.meta.dir, '..');

/** Run a tool and return its stdout; its stderr is the error when it fails. */
function out(argv: string[]): string {
  const p = Bun.spawnSync(argv, { stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`${argv.join(' ')}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString();
}

/** Long steps (dependency installs, downloads) show their own progress. */
function loud(argv: string[]): void {
  const p = Bun.spawnSync(argv, { stdout: 'inherit', stderr: 'inherit' });
  if (p.exitCode !== 0) throw new Error(`${argv.join(' ')} failed with ${p.exitCode}`);
}

const git = (dir: string, ...args: string[]) => out(['git', '-C', dir, ...args]).trim();

/** A shallow fetch of the pinned commit; local edits stop the install rather than vanish. */
function checkout(dir: string, pin: Checkout): void {
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, 'remote', 'add', 'origin', pin.repository);
  }
  if (git(dir, 'status', '--porcelain', '--untracked-files=no'))
    throw new Error(`${dir} has local changes; commit or discard them first`);
  const head = Bun.spawnSync(['git', '-C', dir, 'rev-parse', '-q', '--verify', 'HEAD']);
  if (head.stdout.toString().trim() === pin.revision) return;
  git(dir, 'remote', 'set-url', 'origin', pin.repository);
  git(dir, 'fetch', '-q', '--depth', '1', 'origin', pin.revision);
  git(dir, 'checkout', '-q', '--detach', 'FETCH_HEAD');
  console.log(`install: ${dir} at ${pin.revision.slice(0, 7)}`);
}

/** `uv pip sync` makes the venv exactly the lock: the environment each engine was verified in. */
function environment(component: Component, venv: string): void {
  const python = component.python;
  if (!python) return;
  if (!existsSync(join(venv, 'bin/python')))
    out(['uv', 'venv', '-q', '--python', python.version, venv]);
  const index = python.index
    ? ['--extra-index-url', python.index, '--index-strategy', 'unsafe-best-match']
    : [];
  loud([
    'uv',
    'pip',
    'sync',
    '-q',
    '--python',
    join(venv, 'bin/python'),
    ...index,
    join(repo, 'locks', `${python.lock}.txt`),
  ]);
}

/** Unpack verified archives into a fresh directory and swap it in whole, so `code/` is never a mix
 * of two releases. The stamp names the archives it was built from. */
async function release(dir: string, archives: Release[]): Promise<void> {
  const stamp = join(dir, '.release');
  const want = archives.map((archive) => archive.sha256).join('\n');
  if (existsSync(stamp) && (await Bun.file(stamp).text()) === want) return;
  const fresh = `${dir}.new`;
  rmSync(fresh, { recursive: true, force: true });
  mkdirSync(fresh, { recursive: true });
  for (const archive of archives) {
    const part = join(dirname(dir), `${basename(archive.url)}.part`);
    console.log(`install: ${archive.url}`);
    loud([
      'curl',
      '-fL',
      '-#',
      '-C',
      '-',
      '--retry',
      '5',
      '--retry-all-errors',
      '-o',
      part,
      archive.url,
    ]);
    const hasher = new Bun.CryptoHasher('sha256');
    for await (const chunk of Bun.file(part).stream()) hasher.update(chunk);
    if (hasher.digest('hex') !== archive.sha256) {
      rmSync(part);
      throw new Error(`${archive.url}: hash mismatch, download removed`);
    }
    out(['tar', '-xzf', part, '-C', fresh, '--strip-components=1']);
    rmSync(part);
  }
  await Bun.write(join(fresh, '.release'), want);
  rmSync(dir, { recursive: true, force: true });
  renameSync(fresh, dir);
  console.log(`install: ${dir} unpacked`);
}

interface Entry {
  type: string;
  path: string;
  size: number;
  oid: string;
  lfs?: { oid: string; size: number };
}

const endpoint = () => (process.env.HF_ENDPOINT ?? 'https://huggingface.co').replace(/\/$/, '');
const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** The destination a manifest entry gives `path`, if any. */
function destination(files: Record<string, string>, path: string): string | undefined {
  for (const [key, target] of Object.entries(files)) {
    let rest: string;
    if (path === key) rest = basename(path);
    else if ((key === '' || key.endsWith('/')) && path.startsWith(key))
      rest = path.slice(key.length);
    else continue;
    return target.endsWith('/') ? target + rest : target;
  }
  return undefined;
}

function listing(weights: Weights): Entry[] {
  const url = `${endpoint()}/api/models/${weights.repository}/tree/${weights.revision}?recursive=true`;
  const entries: unknown = JSON.parse(out(['curl', '-fsSL', url]));
  if (!Array.isArray(entries)) throw new Error(`${url}: not a file listing`);
  return (entries as Entry[]).filter((entry) => entry.type === 'file');
}

/** LFS files carry a sha256; small files only their git blob id, which is sha1 over a header. */
async function digest(path: string, entry: Entry): Promise<string> {
  const hasher = new Bun.CryptoHasher(entry.lfs ? 'sha256' : 'sha1');
  if (!entry.lfs) hasher.update(`blob ${statSync(path).size}\0`);
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest('hex');
}

const expected = (entry: Entry) => entry.lfs?.oid ?? entry.oid;
const size = (path: string) => (existsSync(path) ? statSync(path).size : -1);

/** Keep a file whose size matches (and hash, when verifying); otherwise resume or redo it in a
 * `.part` beside it, so a destination file only ever holds a verified download. */
async function fetchFile(weights: Weights, entry: Entry, dest: string, verify: boolean) {
  if (size(dest) === entry.size && (!verify || (await digest(dest, entry)) === expected(entry)))
    return false;
  rmSync(dest, { force: true });
  const part = `${dest}.part`;
  if (size(part) > entry.size) rmSync(part);
  mkdirSync(dirname(dest), { recursive: true });
  if (size(part) < entry.size) {
    const url = `${endpoint()}/${weights.repository}/resolve/${weights.revision}/${encode(entry.path)}`;
    console.log(`install: ${weights.repository}/${entry.path}`);
    loud(['curl', '-fL', '-#', '-C', '-', '--retry', '5', '--retry-all-errors', '-o', part, url]);
  }
  if ((await digest(part, entry)) !== expected(entry)) {
    rmSync(part);
    throw new Error(`${weights.repository}/${entry.path}: hash mismatch, partial download removed`);
  }
  renameSync(part, dest);
  return true;
}

async function fetchWeights(root: string, weights: Weights, verify: boolean): Promise<number> {
  const entries = listing(weights);
  const missing = Object.keys(weights.files).filter(
    (key) => !entries.some((entry) => destination({ [key]: '' }, entry.path) !== undefined),
  );
  if (missing.length)
    throw new Error(`${weights.repository}@${weights.revision} has no ${missing.join(', ')}`);
  let fetched = 0;
  for (const entry of entries) {
    const target = destination(weights.files, entry.path);
    if (target !== undefined && (await fetchFile(weights, entry, join(root, target), verify)))
      fetched++;
  }
  return fetched;
}

/** The ComfyUI sidebar saves into this checkout's UI-format workflows, the source of truth. */
function linkWorkflows(data: string): void {
  const link = join(data, 'user/default/workflows');
  const target = join(repo, 'comfyui/workflows');
  const stat = linkStat(link);
  if (stat?.isSymbolicLink() && readlinkSync(link) === target) return;
  if (stat?.isSymbolicLink()) unlinkSync(link);
  else if (stat?.isDirectory() && !readdirSync(link).length) rmdirSync(link);
  else if (stat) throw new Error(`${link} holds workflows; move them into comfyui/workflows`);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link);
}

/** lstat that reports a dangling link instead of treating it as absent. */
function linkStat(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** Code and venv belong to whichever component owns them, so a shared base is set up once. */
async function install(models: string, name: Name, verify: boolean, done: Set<string>) {
  const component = manifest[name];
  const where = paths(models, name);
  const owner = manifest[component.base ?? name];
  if (!done.has(where.code)) {
    done.add(where.code);
    if (owner.code) checkout(where.code, owner.code);
    if (owner.release) await release(where.code, owner.release);
    environment(owner, where.venv);
  }
  if (component.packages)
    loud([
      'uv',
      'pip',
      'install',
      '-q',
      '--python',
      where.python,
      '--no-deps',
      '--target',
      where.packages,
      ...component.packages,
    ]);
  for (const [node, pin] of Object.entries(component.nodes ?? {}))
    checkout(join(where.data, 'custom_nodes', node), pin);
  if (name === 'comfyui') linkWorkflows(where.data);
  let fetched = 0;
  for (const weights of component.weights)
    fetched += await fetchWeights(where.root, weights, verify);
  console.log(`install: ${name} ready${fetched ? `, fetched ${fetched} files` : ''}`);
}

/** Never swap code or weights under a running model: the job on the GPU would break. */
function busy(name: Name): boolean {
  const unit = name === 'comfyui' ? 'comfyui-backend.service' : 'tts-backend.service';
  return Bun.spawnSync(['systemctl', '--user', '--quiet', 'is-active', unit]).exitCode === 0;
}

if (import.meta.main) {
  try {
    const where = places();
    const config = read(where.config);
    const names = served(config);
    if (names.length) {
      for (const tool of ['git', 'uv', 'curl', 'tar', 'systemctl'])
        if (!Bun.which(tool)) throw new Error(`install: ${tool} is not on PATH`);
      const verify = process.argv.includes('--verify');
      const done = new Set<string>();
      for (const name of names)
        if (busy(name)) console.log(`install: ${name} is running; skipped, rerun when idle`);
        else await install(modelRoot(config, where), name, verify, done);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
