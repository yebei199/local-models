// model-web: the page directory as a browser sees it, over a real loopback socket.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

/** Start the server on `root` and return its base URL once it answers. */
async function serve(root: string, path = process.env.PATH ?? ''): Promise<string> {
  const port = freePort();
  const child = Bun.spawn([process.execPath, resolve('src/web.ts')], {
    env: { PATH: path, PORT: String(port), WEB_DIR: root },
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

describe('home page', () => {
  test('lists pages newest first and leaves other files out', async () => {
    const html = await (await fetch(await serve(site()))).text();
    expect(html.indexOf('music/')).toBeLessThan(html.indexOf('blind.html'));
    expect(html).toContain('盲听');
    expect(html).not.toContain('notes.txt');
  });

  test('treats a page title as text', async () => {
    const html = await (await fetch(await serve(site()))).text();
    expect(html).toContain('音乐 &lt;b&gt;试听');
  });

  test('says so when there is nothing to show', async () => {
    const root = join(scratch(), 'web');
    mkdirSync(root);
    expect(await (await fetch(await serve(root))).text()).toContain('还没有页面');
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

  test('shows VRAM and which services hold the GPU', async () => {
    const dir = scratch();
    const html = await (await fetch(await serve(site(), busyHost(dir)))).text();
    expect(html).toContain('4.0 / 16.0 GiB');
    expect(html).toContain('width:25%');
    expect(html).toContain('badge on');
  });

  test('leaves the strip out on a host without a GPU', async () => {
    const dir = scratch();
    const bin = fakeTool(dir, 'systemctl', "console.log('inactive');");
    const html = await (await fetch(await serve(site(), bin))).text();
    expect(html).not.toContain('显存');
    expect(html).toContain('盲听');
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

  test('renders the comparison with the shared player', async () => {
    const base = await serve(withAudition(JSON.stringify(audition)));
    const html = await (await fetch(`${base}/voices/`)).text();
    expect(html).toContain('音色 &lt;对比&gt;');
    expect(html).toContain('data-src="a.mp3"');
    expect(html).toContain('英语 · 第一句 · 甲');
    expect(html).not.toContain('<table');
    expect(html).toContain('/assets/player.js');
  });

  test('lists it with its size', async () => {
    const html = await (await fetch(await serve(withAudition(JSON.stringify(audition))))).text();
    expect(html).toContain('3 段');
    expect(html).toContain('同一句话');
  });

  test('says which row is wrong instead of rendering an empty one', async () => {
    const broken = structuredClone(audition);
    broken.sections[0]?.rows[0]?.takes.pop();
    const base = await serve(withAudition(JSON.stringify(broken)));
    const response = await fetch(`${base}/voices/`);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('第一句');
  });

  test('keeps a broken audition listed', async () => {
    const html = await (await fetch(await serve(withAudition('{')))).text();
    expect(html).toContain('audition.json 有误');
  });

  test('serves the assets', async () => {
    const base = await serve(site());
    expect((await fetch(`${base}/assets/page.css`)).status).toBe(200);
    const script = await fetch(`${base}/assets/player.js`);
    expect(script.headers.get('Content-Type')).toContain('javascript');
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
    env: { PATH: process.env.PATH ?? '', PORT: '8096' },
    stderr: 'pipe',
  });
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain('WEB_DIR');
});
