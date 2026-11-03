import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeTool, run, scratch } from './helpers.ts';

/** Fake nvidia-smi reporting `free` MiB. */
function gpu(dir: string, free: string): Record<string, string> {
  const bin = fakeTool(dir, 'nvidia-smi', `console.log(${JSON.stringify(free)});`);
  return { PATH: `${bin}:${process.env.PATH}` };
}

test('vram passes when the card has room', async () => {
  expect((await run('backend', ['vram', '9000', '0'], gpu(scratch(), '12000'))).status).toBe(0);
});

test('vram refuses to start beside a job holding the card', async () => {
  const result = await run('backend', ['vram', '9000', '0'], gpu(scratch(), '4000'));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Only 4000 MiB');
});

test('vram waits for a finished job to release the card', async () => {
  const dir = scratch();
  const count = join(dir, 'count');
  const bin = fakeTool(
    dir,
    'nvidia-smi',
    `import { appendFileSync, existsSync } from 'node:fs';
console.log(existsSync(${JSON.stringify(count)}) ? '12000' : '3000');
appendFileSync(${JSON.stringify(count)}, 'x');`,
  );
  const result = await run('backend', ['vram', '9000', '5'], {
    PATH: `${bin}:${process.env.PATH}`,
  });
  expect(result).toMatchObject({ status: 0 });
});

test('unreadable VRAM counts as a refusal', async () => {
  const dir = scratch();
  const bin = fakeTool(dir, 'nvidia-smi', 'process.exit(9);');
  const result = await run('backend', ['vram', '1', '0'], { PATH: `${bin}:${process.env.PATH}` });
  expect(result.status).toBe(1);
});

test('wait returns once the port is bound', async () => {
  const dir = scratch();
  const bin = fakeTool(dir, 'ss', "console.log('LISTEN 0 128 127.0.0.1:8089');");
  const result = await run('backend', ['wait'], {
    PORT: '8089',
    PATH: `${bin}:${process.env.PATH}`,
  });
  expect(result.status).toBe(0);
});

test('an invalid port is refused', async () => {
  expect((await run('backend', ['wait'], { PORT: 'x' })).status).toBe(1);
});

test('start launches ComfyUI on loopback and the tailnet, keeping its exit status', async () => {
  const dir = scratch();
  const python = join(dir, 'ComfyUI/.venv/bin/python');
  mkdirSync(join(dir, 'ComfyUI/.venv/bin'), { recursive: true });
  const log = join(dir, 'args.log');
  writeFileSync(python, `#!/bin/sh\necho "$LD_LIBRARY_PATH $*" > "${log}"\nexit 3\n`);
  chmodSync(python, 0o755);
  fakeTool(dir, 'ss', 'process.exit(1);');
  const bin = fakeTool(dir, 'tailscale', "console.log('100.64.0.1');");
  const result = await run('backend', ['start', '--extra'], {
    PORT: '8089',
    COMFYUI_DIR: dir,
    CUDA_LIB: '/cuda',
    PATH: `${bin}:${process.env.PATH}`,
  });
  expect(result.status).toBe(3);
  const args = readFileSync(log, 'utf8');
  expect(args).toStartWith('/cuda ');
  expect(args).toContain('--listen 127.0.0.1,100.64.0.1 --port 8089');
  expect(args).toEndWith('--extra\n');
});
