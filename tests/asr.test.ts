import { afterEach, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeTool, run, scratch } from './helpers.ts';

/** What the fake gate saw in one request. */
interface Seen {
  name: string;
  audio: string;
  language: string | null;
}

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

/** Stand in for the gate, answering each request with the next of `answers`. */
function gate(answers: Response[]): { port: string; seen: Seen[] } {
  const seen: Seen[] = [];
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (new URL(request.url).pathname !== '/v1/audio/transcriptions')
        return new Response('not found', { status: 404 });
      const form = await request.formData();
      const file = form.get('file') as File;
      seen.push({
        name: file.name,
        audio: await file.text(),
        language: form.get('language') as string | null,
      });
      return answers.shift() ?? new Response('no answer', { status: 500 });
    },
  });
  return { port: String(server.port), seen };
}

const TRANSCRIPT = {
  lang: 'zh',
  model: 'Qwen/Qwen3-ASR-1.7B@7278e1e7',
  duration: 3.5,
  segments: [{ from: 0.2, to: 3.1, text: '你好。', lang: 'zh' }],
};

/** An audio file and the path its transcript should land at. */
function files(): { audio: string; output: string; dir: string } {
  const dir = scratch();
  const audio = join(dir, 'clip.m4a');
  writeFileSync(audio, 'sound');
  return { audio, output: join(dir, 'out.json'), dir };
}

test('transcribe uploads the audio and writes the answer as it came', async () => {
  const { port, seen } = gate([Response.json(TRANSCRIPT)]);
  const { audio, output } = files();
  const result = await run('asr', ['transcribe', audio, '-o', output, '--lang', 'zh'], {
    TTS_HOST: '',
    TTS_PORT: port,
  });
  expect(result).toMatchObject({ status: 0 });
  expect(seen).toEqual([{ name: 'clip.m4a', audio: 'sound', language: 'zh' }]);
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(TRANSCRIPT);
});

test('no language means the model decides, and no speech is a valid empty transcript', async () => {
  const empty = { lang: null, model: 'm', duration: 5, segments: [] };
  const { port, seen } = gate([Response.json(empty)]);
  const { audio, output } = files();
  const result = await run('asr', ['transcribe', audio, '-o', output], {
    TTS_HOST: '',
    TTS_PORT: port,
  });
  expect(result).toMatchObject({ status: 0 });
  expect(seen[0]?.language).toBeNull();
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(empty);
});

test('bad arguments stop before any upload', async () => {
  const { port, seen } = gate([]);
  const { audio, output, dir } = files();
  const env = { TTS_HOST: '', TTS_PORT: port };
  const tries = [
    ['transcribe', audio, '-o', output, '--lang', 'fr'],
    ['transcribe', join(dir, 'missing.m4a'), '-o', output],
    ['transcribe', audio],
    ['speak', audio, '-o', output],
  ];
  for (const args of tries) expect((await run('asr', args, env)).status).toBe(1);
  expect(seen).toEqual([]);
});

test('a refusal or an answer without lines fails and leaves no file', async () => {
  const { port } = gate([
    new Response('cannot decode audio', { status: 400 }),
    Response.json({ lang: 'en' }),
  ]);
  const { audio, output } = files();
  const env = { TTS_HOST: '', TTS_PORT: port };
  const refused = await run('asr', ['transcribe', audio, '-o', output], env);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('cannot decode audio');
  const hollow = await run('asr', ['transcribe', audio, '-o', output], env);
  expect(hollow.status).toBe(1);
  expect(hollow.stderr).toContain('no segment list');
  expect(existsSync(output)).toBe(false);
});

/** Relays the forwarded unix socket to the fake gate, the way ssh -L would. */
const RELAY = `
const args = process.argv.slice(2);
const [socket, , port] = args[args.indexOf('-L') + 1].split(':');
Bun.serve({ unix: socket, fetch: (request) => {
  const url = new URL(request.url);
  return fetch('http://127.0.0.1:' + port + url.pathname, {
    method: request.method, headers: request.headers, body: request.body,
  });
} });
await Bun.write(process.env.SSH_LOG ?? '', args.join(' '));
`;

test('a remote host is reached through an ssh forward that is removed afterwards', async () => {
  const { port, seen } = gate([Response.json(TRANSCRIPT)]);
  const { audio, output, dir } = files();
  const runtime = join(dir, 'runtime');
  await Bun.write(join(runtime, '.keep'), '');
  const log = join(dir, 'ssh.log');
  const bin = fakeTool(dir, 'ssh', RELAY);
  const result = await run('asr', ['transcribe', audio, '-o', output], {
    TTS_HOST: 'model-host',
    TTS_PORT: port,
    SSH_LOG: log,
    XDG_RUNTIME_DIR: runtime,
    PATH: `${bin}:${process.env.PATH}`,
  });
  expect(result).toMatchObject({ status: 0 });
  expect(seen).toHaveLength(1);
  expect(readFileSync(log, 'utf8')).toEndWith(`:127.0.0.1:${port} model-host`);
  expect(readdirSync(runtime)).toEqual(['.keep']);
});
