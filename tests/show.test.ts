import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeTool, run, scratch } from './helpers.ts';

/** A fake mpv that stays open like a window until it is signalled. */
const WINDOW = 'setInterval(() => {}, 1000);';

test('a shown window is recorded and --clear closes it', async () => {
  const dir = scratch();
  const media = join(dir, 'clip.mp4');
  writeFileSync(media, 'x');
  const env = {
    PATH: `${fakeTool(dir, 'mpv', WINDOW)}:${process.env.PATH}`,
    XDG_RUNTIME_DIR: dir,
  };
  const shown = await run('show', [media], env);
  expect(shown).toMatchObject({ status: 0 });
  expect(shown.stdout).toContain('视频');
  const marker = join(dir, 'scene-show-windows');
  const pid = Number(readFileSync(marker, 'utf8').trim());
  expect(() => process.kill(pid, 0)).not.toThrow();
  const cleared = await run('show', ['--clear'], env);
  expect(cleared.stdout).toContain('关掉了 1 个窗口');
  expect(existsSync(marker)).toBe(false);
});

test('a missing file is an error and clearing nothing is not', async () => {
  const dir = scratch();
  const env = { XDG_RUNTIME_DIR: dir };
  expect((await run('show', [join(dir, 'none.png')], env)).status).toBe(1);
  const cleared = await run('show', ['--clear'], env);
  expect(cleared).toMatchObject({ status: 0 });
  expect(cleared.stdout).toContain('没有开着的窗口');
});
