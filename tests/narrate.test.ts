import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, scratch } from './helpers.ts';

/** Render a short lavfi source to a real media file. */
function render(args: string[], output: string): void {
  const p = Bun.spawnSync(['ffmpeg', '-v', 'error', '-y', ...args, output]);
  if (p.exitCode) throw new Error(p.stderr.toString());
}

/** Duration in seconds as ffprobe reports it. */
function duration(path: string): number {
  const p = Bun.spawnSync([
    'ffprobe',
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    path,
  ]);
  return Number(p.stdout.toString());
}

test('narration follows the clip: video + sentence + half a second + word', async () => {
  const dir = scratch();
  const [video, sentence, word, output] = ['v.mp4', 's.wav', 'w.wav', 'o.webm'].map((name) =>
    join(dir, name),
  ) as [string, string, string, string];
  const tone = (seconds: string) => ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`];
  render(['-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=10:d=1'], video);
  render(tone('0.6'), sentence);
  render(tone('0.3'), word);
  const result = await run('narrate', [video, sentence, word, output]);
  expect(result).toMatchObject({ status: 0 });
  expect(Math.abs(duration(output) - 2.4)).toBeLessThan(0.15);
});

test('an empty narration file is refused', async () => {
  const dir = scratch();
  const empty = join(dir, 'empty.wav');
  writeFileSync(empty, '');
  const result = await run('narrate', [empty, empty, empty, join(dir, 'o.webm')]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('is empty');
});
