// Black-box harness: real child processes and files, with external tools faked on PATH.

import { afterEach } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory removed after the current test. */
export function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lm-test-'));
  directories.push(dir);
  return dir;
}

/** Put an executable named `name` into `dir/bin`; `body` is TypeScript run by Bun. */
export function fakeTool(dir: string, name: string, body: string): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = join(dir, `${name}.fake.ts`);
  writeFileSync(script, body);
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(path, 0o755);
  return bin;
}

/** Put a `/bin/sh` script named `name` into `dir/bin`, for fakes called often enough that Bun's
 * startup would dominate the test. */
export function fakeShell(dir: string, name: string, body: string): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return bin;
}

/** What a finished command left behind. */
export interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run one entry script the way its wrapper does, with only the given environment. */
export async function run(
  entry: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<Result> {
  const child = Bun.spawn([process.execPath, resolve('src', `${entry}.ts`), '--', ...args], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { status, stdout, stderr };
}

const handedOut = new Set<number>();

/** A free loopback port for a server under test to bind later. Drawn below Linux's ephemeral
 * range (32768+) because the port sits unbound until the child starts, and on a busy host any
 * outgoing connection can take an ephemeral port in that window; the child then dies on bind. */
export function freePort(): number {
  for (;;) {
    const port = 20000 + Math.floor(Math.random() * 12768);
    if (handedOut.has(port)) continue;
    try {
      Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response() }).stop(true);
    } catch {
      continue;
    }
    handedOut.add(port);
    return port;
  }
}

/** Wait until `url` answers, failing at once with the child's stderr if it exits first. */
export async function untilUp(child: Bun.Subprocess<'ignore', 'ignore', 'pipe'>, url: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(url).catch(() => undefined)) return;
    if (child.exitCode !== null) {
      throw new Error(
        `${url} exited ${child.exitCode}: ${await new Response(child.stderr).text()}`,
      );
    }
    await Bun.sleep(50);
  }
  throw new Error(`${url} did not answer`);
}
