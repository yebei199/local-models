// model-web: the page directory and the API as a browser sees them, over a real loopback socket.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Entry } from '../src/audition';
import { fakeTool, scratch } from './helpers';

const children: Bun.Subprocess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

/** An unused loopback port, released before the server under test binds it. */
function freePort(): number {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const { port } = probe;
  probe.stop(true);
  return port as number;
}

/** A stand-in for the built browser app: its shell and one asset. */
function app(): string {
  const ui = join(scratch(), 'ui');
  mkdirSync(join(ui, 'assets'), { recursive: true });
  writeFileSync(join(ui, 'index.html'), '<div id="root"></div>');
  writeFileSync(join(ui, 'assets/index.js'), 'export {};');
  return ui;
}

/** Start the server on `root` and return its base URL once it answers. */
async function serve(root: string, path = process.env.PATH ?? ''): Promise<string> {
  const port = freePort();
  const child = Bun.spawn([process.execPath, resolve('src/web.ts')], {
    env: { PATH: path, PORT: String(port), WEB_DIR: root, WEB_UI: app() },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await fetch(base).catch(() => null);
    if (ready) return base;
    await Bun.sleep(50);
  }
  throw new Error('server did not start');
}

/** A directory with one page folder, one standalone page, and files that must stay private. */
function site(): string {
  const dir = scratch();
  const root = join(dir, 'web');
  mkdirSync(join(root, 'music/.secret'), { recursive: true });
  writeFileSync(join(root, 'music/index.html'), '<title>音乐 <b>试听</title>');
  writeFileSync(join(root, 'music/a.mp3'), '0123456789');
  writeFileSync(join(root, 'music/.secret/key.json'), '{}');
  writeFileSync(join(root, 'blind.html'), '<title>盲听</title>');
  writeFileSync(join(root, 'notes.txt'), 'not a page');
  writeFileSync(join(dir, 'outside.txt'), 'outside');
  symlinkSync(join(dir, 'outside.txt'), join(root, 'link.txt'));
  utimesSync(join(root, 'blind.html'), new Date(0), new Date(0));
  return root;
}

/** The published pages as the home page reads them. */
async function pages(base: string): Promise<Entry[]> {
  return (await (await fetch(`${base}/api/pages`)).json()) as Entry[];
}

describe('home page', () => {
  test('is the app shell', async () => {
    expect(await (await fetch(await serve(site()))).text()).toContain('id="root"');
  });

  test('lists pages newest first and leaves other files out', async () => {
    const list = await pages(await serve(site()));
    expect(list.map((entry) => entry.href)).toEqual(['/music/', '/blind.html']);
    expect(list[0]?.title).toBe('音乐 <b>试听');
    expect(list[1]?.title).toBe('盲听');
  });

  test('is empty when there is nothing to show', async () => {
    const root = join(scratch(), 'web');
    mkdirSync(root);
    expect(await pages(await serve(root))).toEqual([]);
  });
});

describe('machine state', () => {
  /** PATH with a GPU at 4096 of 16384 MiB and only the speech gate running. */
  function busyHost(dir: string): string {
    fakeTool(dir, 'nvidia-smi', "console.log('4096, 16384');");
    const script =
      "console.log(process.argv.at(-1) === 'tts-backend.service' ? 'active' : 'inactive');";
    return `${fakeTool(dir, 'systemctl', script)}:${process.env.PATH}`;
  }

  test('reports VRAM and which services hold the GPU', async () => {
    const base = await serve(site(), busyHost(scratch()));
    expect(await (await fetch(`${base}/api/machine`)).json()).toEqual({
      usedMib: 4096,
      totalMib: 16384,
      speech: true,
      images: false,
    });
  });

  test('is null on a host without a GPU', async () => {
    const bin = fakeTool(scratch(), 'systemctl', "console.log('inactive');");
    const base = await serve(site(), bin);
    expect(await (await fetch(`${base}/api/machine`)).json()).toBeNull();
  });
});

describe('auditions', () => {
  const audition = {
    title: '音色 <对比>',
    description: '同一句话',
    sections: [
      {
        title: '英语',
        rows: [
          { label: '第一句', note: '短句', takes: [{ src: 'a.mp3', label: '甲', meta: '0:03' }] },
          {
            label: '第二句',
            takes: [
              { src: 'b.mp3', label: '甲' },
              { src: 'c.mp3', label: '乙' },
            ],
          },
        ],
      },
    ],
  };

  /** A site with the audition above in `voices/`. */
  function withAudition(data: string): string {
    const root = site();
    mkdirSync(join(root, 'voices'));
    writeFileSync(join(root, 'voices/audition.json'), data);
    return root;
  }

  test('renders through the app at its own directory', async () => {
    const base = await serve(withAudition(JSON.stringify(audition)));
    expect(await (await fetch(`${base}/voices/`)).text()).toContain('id="root"');
    expect(await (await fetch(`${base}/api/auditions/voices`)).json()).toEqual(audition);
  });

  test('lists it with its size', async () => {
    const list = await pages(await serve(withAudition(JSON.stringify(audition))));
    const voices = list.find((entry) => entry.href === '/voices/');
    expect(voices).toMatchObject({ title: '音色 <对比>', takes: 3, description: '同一句话' });
  });

  test('says which row is wrong instead of rendering an empty one', async () => {
    const broken = structuredClone(audition);
    broken.sections[0]?.rows[0]?.takes.pop();
    const base = await serve(withAudition(JSON.stringify(broken)));
    const response = await fetch(`${base}/api/auditions/voices`);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('第一句');
  });

  test('keeps a broken audition listed', async () => {
    const list = await pages(await serve(withAudition('{')));
    expect(list.find((entry) => entry.href === '/voices/')?.description).toBe('audition.json 有误');
  });

  test.each([['/api/auditions/music'], ['/api/auditions/.secret'], ['/api/other']])(
    'answers %s with 404',
    async (path) => {
      const base = await serve(withAudition(JSON.stringify(audition)));
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    },
  );

  test('serves the app assets', async () => {
    const base = await serve(site());
    const script = await fetch(`${base}/assets/index.js`);
    expect(script.headers.get('Content-Type')).toContain('javascript');
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
  });
});

describe('files', () => {
  test('tells browsers to revalidate and that they can seek', async () => {
    const response = await fetch(`${await serve(site())}/music/a.mp3`);
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Type')).toContain('audio/mpeg');
    expect(await response.text()).toBe('0123456789');
  });

  test.each([
    ['bytes=2-4', '234', 'bytes 2-4/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=-2', '89', 'bytes 8-9/10'],
    ['bytes=8-99', '89', 'bytes 8-9/10'],
  ])('answers %s with the part asked for', async (range, body, contentRange) => {
    const response = await fetch(`${await serve(site())}/music/a.mp3`, {
      headers: { Range: range },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe(contentRange);
    expect(await response.text()).toBe(body);
  });

  test('refuses a range past the end', async () => {
    const response = await fetch(`${await serve(site())}/music/a.mp3`, {
      headers: { Range: 'bytes=10-' },
    });
    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */10');
  });

  test('sends a directory to its slash so relative audio paths resolve', async () => {
    const base = await serve(site());
    const response = await fetch(`${base}/music`, { redirect: 'manual' });
    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('/music/');
    expect(await (await fetch(`${base}/music/`)).text()).toContain('音乐');
  });
});

describe('private paths', () => {
  test.each([
    ['/music/.secret/key.json'],
    ['/music/%2e%2e/%2e%2e/outside.txt'],
    ['/music/..%2f..%2foutside.txt'],
    ['/link.txt'],
    ['/missing.html'],
    ['/%zz'],
  ])('hides %s', async (path) => {
    const base = await serve(site());
    expect((await fetch(`${base}${path}`)).status).toBe(404);
  });

  test('accepts only reads', async () => {
    const response = await fetch(await serve(site()), { method: 'POST' });
    expect(response.status).toBe(405);
  });
});

test('refuses to start without a directory', async () => {
  const child = Bun.spawn([process.execPath, resolve('src/web.ts')], {
    env: { PATH: process.env.PATH ?? '', PORT: '8096', WEB_UI: app() },
    stderr: 'pipe',
  });
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain('WEB_DIR');
});
