import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fakeTool, scratch } from './helpers.ts';

const children: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGTERM');
    await child.exited;
  }
});

/** A port nothing is listening on yet. */
function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => done(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/** A fake engine: logs its life cycle and echoes what it was asked in the audio bytes. */
const ENGINE = `
import { appendFileSync } from 'node:fs';
const [name, port, log] = process.argv.slice(2);
const note = (line) => appendFileSync(log, line + '\\n');
note('start ' + name);
process.on('SIGTERM', () => { note('stop ' + name); process.exit(0); });
Bun.serve({
  hostname: '127.0.0.1',
  port: Number(port),
  async fetch(request) {
    if (request.method === 'GET') return new Response('ready');
    const form = await request.formData();
    const audio = await form.get('ref_audio').text();
    if (form.get('text') === 'boom') return new Response('engine broke', { status: 500 });
    note('speak ' + name + ' ' + form.get('text'));
    return new Response(
      [name, form.get('language'), form.get('ref_text'), audio].join('|'),
      { headers: { 'X-Sample-Rate': '24000' } },
    );
  },
});
`;

/** Start the gate with two fake engines and a fake GPU reporting `free` MiB. */
async function start(dir: string, free = '12000') {
  const [gatePort, enginePort] = [await freePort(), await freePort()];
  const log = join(dir, 'log');
  writeFileSync(log, '');
  const script = join(dir, 'engine.ts');
  writeFileSync(script, ENGINE);
  const bin = fakeTool(dir, 'nvidia-smi', `console.log(${JSON.stringify(free)});`);
  const voice = join(dir, 'voice.wav');
  writeFileSync(voice, 'fixed-audio');
  const engine = (name: string) => ({
    command: [process.execPath, script, name, String(enginePort), log],
    directory: dir,
    environment: {},
    vram: 9000,
  });
  const config = join(dir, 'gate.json');
  writeFileSync(
    config,
    JSON.stringify({
      enginePort,
      vramWait: 0,
      voice: { path: voice, text: 'fixed words' },
      routes: { anki: { en: 'one', ja: 'two' } },
      engines: { one: engine('one'), two: engine('two') },
    }),
  );
  const gate = Bun.spawn([process.execPath, resolve('src/gate.ts')], {
    env: { PATH: `${bin}:${process.env.PATH}`, PORT: String(gatePort), GATE_CONFIG: config },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  children.push(gate);
  for (let attempt = 0; attempt < 100; attempt++) {
    const up = await fetch(`http://127.0.0.1:${gatePort}/`).catch(() => undefined);
    if (up) break;
    await Bun.sleep(50);
  }
  const speak = (text: string, language: string, extra?: (form: FormData) => void) => {
    const body = new FormData();
    body.append('text', text);
    body.append('use', 'anki');
    body.append('language', language);
    extra?.(body);
    return fetch(`http://127.0.0.1:${gatePort}/v1/audio/speech`, { method: 'POST', body });
  };
  return { gate, log, speak };
}

const lines = (path: string) => readFileSync(path, 'utf8').trim().split('\n');

test('the route picks the engine and the fixed voice is filled in', async () => {
  const { speak } = await start(scratch());
  const response = await speak('hi', 'ja');
  expect(response.status).toBe(200);
  expect(response.headers.get('X-Sample-Rate')).toBe('24000');
  expect(await response.text()).toBe('two|ja|fixed words|fixed-audio');
});

test('a caller voice replaces the fixed one', async () => {
  const { speak } = await start(scratch());
  const response = await speak('hi', 'en', (form) => {
    form.append('ref_text', 'my words');
    form.append('ref_audio', new Blob(['my-audio']), 'mine.wav');
  });
  expect(await response.text()).toBe('one|en|my words|my-audio');
});

test('an engine stays loaded for its route and leaves before the next one starts', async () => {
  const { log, speak } = await start(scratch());
  await speak('a', 'en');
  await speak('b', 'en');
  await speak('c', 'ja');
  expect(lines(log)).toEqual([
    'start one',
    'speak one a',
    'speak one b',
    'stop one',
    'start two',
    'speak two c',
  ]);
});

test('simultaneous requests are served one at a time without an error', async () => {
  const { log, speak } = await start(scratch());
  const responses = await Promise.all([speak('a', 'en'), speak('b', 'ja'), speak('c', 'en')]);
  expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
  const events = lines(log);
  expect(events.filter((line) => line.startsWith('start'))).toHaveLength(3);
  expect(events.indexOf('stop one')).toBeLessThan(events.indexOf('start two'));
});

test('an unknown route is refused without loading a model', async () => {
  const { log, speak } = await start(scratch());
  const response = await speak('a', 'fr');
  expect(response.status).toBe(400);
  expect(await response.text()).toContain('anki/fr');
  expect(readFileSync(log, 'utf8')).toBe('');
});

test('an engine failure reaches the caller and the next request still works', async () => {
  const { speak } = await start(scratch());
  const failed = await speak('boom', 'en');
  expect(failed.status).toBe(500);
  expect(await failed.text()).toBe('engine broke');
  expect((await speak('ok', 'en')).status).toBe(200);
});

test('stopping the gate stops the engine, so its VRAM returns', async () => {
  const { gate, log, speak } = await start(scratch());
  await speak('a', 'en');
  gate.kill('SIGTERM');
  await gate.exited;
  expect(lines(log).at(-1)).toBe('stop one');
});

test('a card held by another job is refused instead of killing that job', async () => {
  const dir = scratch();
  const { log, speak } = await start(dir, '100');
  appendFileSync(log, '');
  const response = await speak('a', 'en');
  expect(response.status).toBe(503);
  expect(await response.text()).toContain('Only 100 MiB');
  expect(readFileSync(log, 'utf8')).toBe('');
});
