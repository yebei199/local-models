// install: a model host fetched from a fake Hugging Face endpoint, with git, uv and systemctl faked.

import { afterAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { manifest } from '../src/manifest';
import { fakeShell, scratch } from './helpers';

/** Files the fake endpoint serves for one manifest entry: the named files, two per subtree. */
function tree(repository: string, revision: string): string[] {
  const entry = Object.values(manifest)
    .flatMap((component) => component.weights)
    .find((weights) => weights.repository === repository && weights.revision === revision);
  if (!entry) return [];
  return Object.keys(entry.files).flatMap((key) =>
    key === '' || key.endsWith('/') ? [`${key}config.json`, `${key}deep/model.bin`] : [key],
  );
}

const content = (path: string) => `weights of ${path}\n`;
const lfs = (path: string) => path.endsWith('.bin') || /\.(safetensors|gguf|pth)$/.test(path);

function hash(path: string, body: string): string {
  if (lfs(path)) return new Bun.CryptoHasher('sha256').update(body).digest('hex');
  return new Bun.CryptoHasher('sha1').update(`blob ${body.length}\0${body}`).digest('hex');
}

/** Tampered paths answer with a same-size body that no longer matches the listed hash. */
const tampered = new Set<string>();
let downloads = 0;

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    const listing = url.pathname.match(/^\/api\/models\/(.+)\/tree\/([0-9a-f]+)$/);
    if (listing) {
      const [, repository, revision] = listing as unknown as [string, string, string];
      return Response.json(
        tree(repository, revision).map((path) => {
          const body = content(path);
          const oid = hash(path, body);
          const size = body.length;
          return lfs(path)
            ? { type: 'file', path, size, oid: 'pointer', lfs: { oid, size } }
            : { type: 'file', path, size, oid };
        }),
      );
    }
    const file = url.pathname.match(/^\/(.+?\/.+?)\/resolve\/[0-9a-f]+\/(.+)$/);
    if (!file) return new Response('not found', { status: 404 });
    downloads++;
    const path = decodeURIComponent(file[2] as string);
    const body = tampered.has(path) ? content(path).toUpperCase() : content(path);
    const from = Number(request.headers.get('range')?.match(/bytes=(\d+)-/)?.[1] ?? 0);
    return new Response(body.slice(from), {
      status: from ? 206 : 200,
      headers: from ? { 'content-range': `bytes ${from}-${body.length - 1}/${body.length}` } : {},
    });
  },
});
afterAll(() => server.stop(true));

/** git keeps its whole state in files the test can read and poke. */
const fakeGit = `dir=$2; command=$3; shift 3
for a; do last=$a; done
echo "git $(basename "$dir") $command $*" >> "$LOG"
case $command in
  init) mkdir -p "$dir/.git" ;;
  status) [ -e "$dir/dirty" ] && echo ' M file' ;;
  rev-parse) [ -f "$dir/.git/HEAD" ] || exit 1; cat "$dir/.git/HEAD" ;;
  fetch) printf %s "$last" > "$dir/.git/FETCH_HEAD" ;;
  checkout) cp "$dir/.git/FETCH_HEAD" "$dir/.git/HEAD" ;;
esac
exit 0`;

const fakeUv = `echo "uv $*" >> "$LOG"
for a; do last=$a; done
if [ "$1" = venv ]; then mkdir -p "$last/bin" && : > "$last/bin/python"; fi`;

const fakeSystemctl = `for a; do last=$a; done
case ",$ACTIVE," in *",$last,"*) exit 0 ;; esac
exit 3`;

/** Release archives come from GitHub, which tests must not reach; the stand-in is not the pinned
 * archive, so its hash never matches. Everything else goes to the real curl and the fake endpoint. */
const fakeCurl = `for a; do case $a in https://github.com/*) github=1 ;; esac; done
if [ -n "$github" ]; then
  echo "curl $*" >> "$LOG"
  while [ "$1" != -o ]; do shift; done
  echo 'not the archive' > "$2"
  exit 0
fi
exec ${Bun.which('curl')} "$@"`;

/** ComfyUI, Irodori, and tiny without Ming: tiny must still get Ming's checkout and venv. */
const modelHost = {
  host: 'pc3',
  comfyui: { url: 'https://pc3.example:18088', serve: true },
  tts: { voices: {}, engines: { irodori: {}, 'ming-tiny': {} } },
};

interface Host {
  models: string;
  log: () => string;
  run: (config: object, options?: { args?: string[]; active?: string[] }) => Promise<string>;
  status: () => number;
}

function host(): Host {
  const dir = scratch();
  const home = join(dir, 'home');
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  fakeShell(dir, 'git', fakeGit);
  fakeShell(dir, 'uv', fakeUv);
  fakeShell(dir, 'curl', fakeCurl);
  const bin = fakeShell(dir, 'systemctl', fakeSystemctl);
  let status = 0;
  return {
    models: join(home, '.local/share/local-models/models'),
    log: () => readFileSync(log, 'utf8'),
    status: () => status,
    async run(config, { args = [], active = [] } = {}) {
      mkdirSync(join(home, '.config/local-models'), { recursive: true });
      writeFileSync(join(home, '.config/local-models/config.json'), JSON.stringify(config));
      const child = Bun.spawn([process.execPath, resolve('src/install.ts'), '--', ...args], {
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: home,
          LOG: log,
          ACTIVE: active.join(','),
          HF_ENDPOINT: server.url.href,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      status = code;
      return stdout + stderr;
    },
  };
}

const read = (path: string) => readFileSync(path, 'utf8');

describe('a fresh model host', () => {
  test('gets every pinned file where its service looks for it', async () => {
    const h = host();
    const out = await h.run(modelHost);
    expect(h.status()).toBe(0);
    const comfy = join(h.models, 'comfyui/data/models');
    expect(read(join(comfy, 'unet/flux-2-klein-9b-Q8_0.gguf'))).toBe(
      content('flux-2-klein-9b-Q8_0.gguf'),
    );
    expect(existsSync(join(comfy, 'vae/flux2-vae.safetensors'))).toBe(true);
    expect(
      existsSync(join(comfy, 'diffusion_models/MiniMax_H3_Ref2VA_pruned_nvfp4.safetensors')),
    ).toBe(true);
    const irodori = join(h.models, 'irodori/weights');
    expect(read(join(irodori, 'codec.pth'))).toBe(content('weights.pth'));
    expect(read(join(irodori, 'model.safetensors'))).toBe(content('model.safetensors'));
    expect(read(join(irodori, 'tokenizer/deep/model.bin'))).toBe(
      content('tokenizer/deep/model.bin'),
    );
    expect(read(join(h.models, 'ming-tiny/weights/config.json'))).toBe(content('config.json'));
    expect(existsSync(join(h.models, 'ming/weights'))).toBe(false);
    expect(out).toContain('install: ming-tiny ready');
  });

  test('checks out pinned commits and builds each venv from its lock', async () => {
    const h = host();
    await h.run(modelHost);
    const head = (dir: string) => read(join(h.models, dir, '.git/HEAD'));
    expect(head('comfyui/code')).toBe(manifest.comfyui.code?.revision as string);
    expect(head('comfyui/data/custom_nodes/ComfyUI-GGUF')).toBe(
      manifest.comfyui.nodes?.['ComfyUI-GGUF']?.revision as string,
    );
    expect(head('ming/code')).toBe(manifest.ming.code?.revision as string);
    const calls = h.log();
    expect(calls).toContain(`uv venv -q --python 3.10 ${join(h.models, 'ming/venv')}`);
    expect(calls).toContain(
      `--extra-index-url https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match ${resolve('locks/comfyui.txt')}`,
    );
    expect(calls).toContain(
      `--target ${join(h.models, 'ming-tiny/packages')} x-transformers==2.7.4`,
    );
    expect(calls.match(/uv venv/g)).toHaveLength(3);
    const link = join(h.models, 'comfyui/data/user/default/workflows');
    expect(readlinkSync(link)).toBe(resolve('comfyui/workflows'));
  });

  test('a second run downloads and fetches nothing', async () => {
    const h = host();
    await h.run(modelHost);
    const before = downloads;
    const calls = h.log().length;
    await h.run(modelHost);
    expect(h.status()).toBe(0);
    expect(downloads).toBe(before);
    expect(h.log().slice(calls)).not.toContain(' fetch ');
  });
});

describe('downloads', () => {
  test('resume a partial file instead of starting over', async () => {
    const h = host();
    const dest = join(h.models, 'irodori/weights/codec.pth');
    mkdirSync(join(h.models, 'irodori/weights'), { recursive: true });
    writeFileSync(`${dest}.part`, content('weights.pth').slice(0, 5));
    await h.run({ tts: { voices: {}, engines: { irodori: {} } } });
    expect(read(dest)).toBe(content('weights.pth'));
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  test('a file that does not match its hash is removed and fails the install', async () => {
    const h = host();
    tampered.add('weights.pth');
    try {
      const out = await h.run({ tts: { voices: {}, engines: { irodori: {} } } });
      expect(h.status()).toBe(1);
      expect(out).toContain('weights.pth: hash mismatch');
      const dest = join(h.models, 'irodori/weights/codec.pth');
      expect(existsSync(dest) || existsSync(`${dest}.part`)).toBe(false);
    } finally {
      tampered.delete('weights.pth');
    }
  });

  test('--verify replaces a same-size file whose content changed', async () => {
    const h = host();
    const config = { tts: { voices: {}, engines: { irodori: {} } } };
    await h.run(config);
    const dest = join(h.models, 'irodori/weights/codec.pth');
    writeFileSync(dest, content('weights.pth').toUpperCase());
    await h.run(config);
    expect(read(dest)).not.toBe(content('weights.pth'));
    await h.run(config, { args: ['--verify'] });
    expect(read(dest)).toBe(content('weights.pth'));
    expect(statSync(dest).size).toBe(content('weights.pth').length);
  });
});

describe('release archives', () => {
  const translating = { translate: { serve: true } };

  test('an archive that does not match its hash is removed and leaves no code', async () => {
    const h = host();
    const out = await h.run(translating);
    expect(h.status()).toBe(1);
    expect(out).toContain('hash mismatch, download removed');
    const root = join(h.models, 'translator');
    expect(existsSync(join(root, 'code'))).toBe(false);
    expect(readdirSync(root).filter((name) => name.endsWith('.part'))).toEqual([]);
  });

  test('code unpacked from the pinned archives is not fetched again', async () => {
    const h = host();
    const code = join(h.models, 'translator/code');
    mkdirSync(code, { recursive: true });
    const stamp = (manifest.translator.release ?? []).map((archive) => archive.sha256).join('\n');
    writeFileSync(join(code, '.release'), stamp);
    const out = await h.run(translating);
    expect(h.status()).toBe(0);
    expect(h.log()).not.toContain('github.com');
    expect(read(join(h.models, 'translator/weights/model.gguf'))).toBe(
      content('HY-MT2-7B-Q8_0.gguf'),
    );
    expect(out).toContain('install: translator ready');
  });
});

describe('refusals', () => {
  test('a running backend keeps its code and weights; the rest still installs', async () => {
    const h = host();
    const out = await h.run(modelHost, { active: ['tts-backend.service'] });
    expect(h.status()).toBe(0);
    expect(out).toContain('irodori is running; skipped');
    expect(existsSync(join(h.models, 'irodori'))).toBe(false);
    expect(existsSync(join(h.models, 'comfyui/code/.git/HEAD'))).toBe(true);
  });

  test('a checkout with local edits stops the install', async () => {
    const h = host();
    const config = { tts: { voices: {}, engines: { irodori: {} } } };
    await h.run(config);
    writeFileSync(join(h.models, 'irodori/code/dirty'), '');
    const out = await h.run(config);
    expect(h.status()).toBe(1);
    expect(out).toContain('has local changes');
  });

  test('a client installs nothing', async () => {
    const h = host();
    await h.run({ host: 'pc3', comfyui: { url: 'https://pc3.example:18088' } });
    expect(h.status()).toBe(0);
    expect(h.log()).toBe('');
  });
});
