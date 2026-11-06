import { afterEach, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeTool, run, scratch } from './helpers.ts';

const PCM = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);
const ROUTES = { anki: { en: 'one', zh: 'one', ja: 'two' } };

/** What the fake service saw in one request. */
interface Seen {
  text: string;
  refText: string;
  refAudio: string;
  refName: string;
  use: string;
  language: string;
  instruction: string | null;
  seed: string | null;
}

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

/** Stand in for the gate, replaying `statuses` before answering with audio. */
function breeze(statuses: number[] = []): { port: string; seen: Seen[] } {
  const seen: Seen[] = [];
  const pending = [...statuses];
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (request.method === 'GET') return Response.json(ROUTES);
      const form = await request.formData();
      const status = pending.shift();
      if (status) return new Response('busy or broken', { status });
      const audio = form.get('ref_audio') as File | null;
      seen.push({
        text: String(form.get('text')),
        refText: String(form.get('ref_text')),
        refAudio: (await audio?.text()) ?? '',
        refName: audio?.name ?? '',
        use: String(form.get('use')),
        language: String(form.get('language')),
        instruction: form.get('instruction') as string | null,
        seed: form.get('seed') as string | null,
      });
      return new Response(PCM, { headers: { 'X-Sample-Rate': '24000' } });
    },
  });
  return { port: String(server.port), seen };
}

/** Reach the fake service on this machine. */
function environment(port: string): Record<string, string> {
  return { TTS_HOST: '', TTS_PORT: port };
}

test('synth wraps streamed PCM in a playable WAV and leaves the voice to the gate', async () => {
  const dir = scratch();
  const { port, seen } = breeze();
  const output = join(dir, 'out.wav');
  const result = await run(
    'tts',
    ['synth', '--lang', 'en', '--text', 'hello', '--output', output],
    environment(port),
  );
  expect(result).toMatchObject({ status: 0 });
  expect(result.stdout).toContain(output);
  expect(seen).toEqual([
    {
      text: 'hello',
      refText: 'null',
      refAudio: '',
      refName: '',
      use: 'anki',
      language: 'en',
      instruction: null,
      seed: null,
    },
  ]);
  const file = readFileSync(output);
  expect(file.subarray(0, 4).toString()).toBe('RIFF');
  expect(file.readUInt32LE(24)).toBe(24000);
  expect(file.readUInt16LE(34)).toBe(16);
  expect(file.readUInt32LE(40)).toBe(PCM.length);
  expect([...file.subarray(44)]).toEqual([...PCM]);
});

test('an explicit voice is sent along with instruction and seed', async () => {
  const dir = scratch();
  const { port, seen } = breeze();
  const voice = join(dir, 'other.wav');
  writeFileSync(voice, 'other-audio');
  const args = ['--voice', voice, '--voice-text', 'other words', '--seed', '7'];
  const result = await run(
    'tts',
    [
      'synth',
      '--lang',
      'en',
      '--text',
      'x',
      '--output',
      join(dir, 'o.wav'),
      ...args,
      '--instruction',
      'softly',
    ],
    environment(port),
  );
  expect(result.status).toBe(0);
  expect(seen[0]).toMatchObject({
    refText: 'other words',
    refAudio: 'other-audio',
    instruction: 'softly',
    seed: '7',
  });
});

test('a voice without its transcript is rejected before any request', async () => {
  const dir = scratch();
  const { port, seen } = breeze();
  const result = await run(
    'tts',
    [
      'synth',
      '--lang',
      'en',
      '--text',
      'x',
      '--output',
      join(dir, 'o.wav'),
      '--voice',
      join(dir, 'v.wav'),
    ],
    environment(port),
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('transcript');
  expect(seen).toEqual([]);
});

test('use and lang choose the route, and a bad one stops before any request', async () => {
  const dir = scratch();
  const { port, seen } = breeze();
  const output = join(dir, 'o.wav');
  const args = ['synth', '--text', 'x', '--output', output];
  const good = await run('tts', [...args, '--use', 'video', '--lang', 'ja'], environment(port));
  expect(good.status).toBe(0);
  expect(seen[0]).toMatchObject({ use: 'video', language: 'ja' });
  const bad = await run('tts', [...args, '--lang', 'fr'], environment(port));
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain('lang');
  const missing = await run('tts', args, environment(port));
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('lang is required');
  expect(seen).toHaveLength(1);
});

test('a service error fails the command and leaves no output file', async () => {
  const dir = scratch();
  const { port } = breeze([500]);
  const output = join(dir, 'o.wav');
  const result = await run(
    'tts',
    ['synth', '--lang', 'en', '--text', 'x', '--output', output],
    environment(port),
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('500');
  expect(existsSync(output)).toBe(false);
});

test('batch writes every row relative to the manifest', async () => {
  const dir = scratch();
  const { port, seen } = breeze();
  const manifest = join(dir, 'tasks.jsonl');
  writeFileSync(
    manifest,
    `${JSON.stringify({ text: 'one', output: 'a.wav', lang: 'en' })}\n\n${JSON.stringify({ text: 'two', output: 'b.wav', lang: 'en' })}\n`,
  );
  const result = await run('tts', ['batch', '--batch-file', manifest], environment(port));
  expect(result.status).toBe(0);
  expect(seen.map((row) => row.text)).toEqual(['one', 'two']);
  expect(existsSync(join(dir, 'a.wav')) && existsSync(join(dir, 'b.wav'))).toBe(true);
});

test('batch groups rows by the model that serves them, so each loads once', async () => {
  const dir = scratch();
  const { port, seen } = breeze();
  const manifest = join(dir, 'tasks.jsonl');
  const rows = [
    { text: 'one', output: 'a.wav', lang: 'ja' },
    { text: 'two', output: 'b.wav', lang: 'en' },
    { text: 'three', output: 'c.wav', lang: 'ja' },
    { text: 'four', output: 'd.wav', lang: 'zh' },
  ];
  writeFileSync(manifest, rows.map((row) => JSON.stringify(row)).join('\n'));
  const result = await run('tts', ['batch', '--batch-file', manifest], environment(port));
  expect(result.status).toBe(0);
  expect(seen.map((row) => row.text)).toEqual(['two', 'four', 'one', 'three']);
});

test('a bad batch row stops the run before the first synthesis', async () => {
  const dir = scratch();
  const { port, seen } = breeze();
  const manifest = join(dir, 'tasks.jsonl');
  writeFileSync(
    manifest,
    `${JSON.stringify({ text: 'one', output: 'a.wav', lang: 'en' })}\n{"text":"x"}\n`,
  );
  const result = await run('tts', ['batch', '--batch-file', manifest], environment(port));
  expect(result.status).toBe(1);
  expect(seen).toEqual([]);
});

/** A fake ssh that honours -L by relaying its unix socket to the TCP target. */
const RELAY = `
const spec = process.argv[process.argv.indexOf('-L') + 1] ?? '';
const [socket = '', , target = ''] = spec.split(':');
Bun.serve({
  unix: socket,
  fetch: (request) =>
    fetch('http://127.0.0.1:' + target + new URL(request.url).pathname, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    }),
});
await Bun.write(process.env.SSH_LOG ?? '', process.argv.slice(2).join(' '));
`;

test('a remote host is reached through an ssh forward that is removed afterwards', async () => {
  const dir = scratch();
  const { port, seen } = breeze();
  const runtime = join(dir, 'runtime');
  await Bun.write(join(runtime, '.keep'), '');
  const log = join(dir, 'ssh.log');
  const bin = fakeTool(dir, 'ssh', RELAY);
  const output = join(dir, 'o.wav');
  const result = await run('tts', ['synth', '--lang', 'en', '--text', 'far', '--output', output], {
    ...environment(port),
    TTS_HOST: 'model-host',
    SSH_LOG: log,
    XDG_RUNTIME_DIR: runtime,
    PATH: `${bin}:${process.env.PATH}`,
  });
  expect(result).toMatchObject({ status: 0 });
  expect(seen[0]?.text).toBe('far');
  expect(readFileSync(log, 'utf8')).toEndWith(`:127.0.0.1:${port} model-host`);
  expect(readdirSync(runtime)).toEqual(['.keep']);
});

test('an unreachable host fails with a named error', async () => {
  const dir = scratch();
  const bin = fakeTool(dir, 'ssh', 'process.exit(255);');
  const result = await run(
    'tts',
    ['synth', '--lang', 'en', '--text', 'x', '--output', join(dir, 'o.wav')],
    {
      ...environment('1'),
      TTS_HOST: 'model-host',
      PATH: `${bin}:${process.env.PATH}`,
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('model-host');
});
