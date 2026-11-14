import { afterEach, describe, expect, test } from 'bun:test';
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
  const voice = (name: string) => {
    const path = join(dir, `${name}.wav`);
    writeFileSync(path, `${name}-audio`);
    return { path, text: `${name} words` };
  };
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
      voices: { anki: { en: voice('en'), ja: voice('ja') }, video: { en: voice('story') } },
      routes: { anki: { en: 'one', ja: 'two' }, video: { en: 'one' } },
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
  const speak = (
    text: string,
    language: string,
    extra?: (form: FormData) => void,
    use = 'anki',
  ) => {
    const body = new FormData();
    body.append('text', text);
    body.append('use', use);
    body.append('language', language);
    extra?.(body);
    return fetch(`http://127.0.0.1:${gatePort}/v1/audio/speech`, { method: 'POST', body });
  };
  return { gate, log, speak, url: `http://127.0.0.1:${gatePort}` };
}

const lines = (path: string) => readFileSync(path, 'utf8').trim().split('\n');

test('the route picks the engine and the language picks the fixed voice', async () => {
  const { speak } = await start(scratch());
  const response = await speak('hi', 'ja');
  expect(response.status).toBe(200);
  expect(response.headers.get('X-Sample-Rate')).toBe('24000');
  expect(await response.text()).toBe('two|ja|ja words|ja-audio');
  expect(await (await speak('hi', 'en')).text()).toBe('one|en|en words|en-audio');
});

test('each use has its own fixed voice, so narration and flashcards can sound different', async () => {
  const { speak } = await start(scratch());
  expect(await (await speak('hi', 'en', undefined, 'video')).text()).toBe(
    'one|en|story words|story-audio',
  );
  expect(await (await speak('hi', 'en')).text()).toBe('one|en|en words|en-audio');
});

test('a route without a voice for its language stops the gate at start', async () => {
  const dir = scratch();
  const config = join(dir, 'gate.json');
  const engine = { command: ['true'], directory: dir, environment: {}, vram: 1 };
  writeFileSync(
    config,
    JSON.stringify({
      voices: { anki: {} },
      routes: { anki: { en: 'one' } },
      engines: { one: engine },
    }),
  );
  const gate = Bun.spawn([process.execPath, resolve('src/gate.ts')], {
    env: { ...process.env, PORT: String(await freePort()), GATE_CONFIG: config },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  children.push(gate);
  expect(await gate.exited).not.toBe(0);
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

/** A fake llama-server: binds at once, answers 503 on /health until "loaded", then translates by
 * tagging the last line of the prompt. */
const TRANSLATOR = `
import { appendFileSync } from 'node:fs';
const [port, log] = process.argv.slice(2);
const note = (line) => appendFileSync(log, line + '\\n');
note('start translator');
process.on('SIGTERM', () => { note('stop translator'); process.exit(0); });
let probes = 0;
Bun.serve({
  hostname: '127.0.0.1',
  port: Number(port),
  async fetch(request) {
    if (request.method === 'GET') return new Response('', { status: ++probes < 3 ? 503 : 200 });
    if (probes < 3) return new Response('still loading', { status: 503 });
    const body = await request.json();
    const prompt = body.messages[0].content;
    note('translate ' + prompt.split('\\n').at(-1));
    return Response.json({ choices: [{ message: { content: ' [' + prompt.split('\\n').at(-1) + ']\\n' } }] });
  },
});
`;

/** A fake transcriber: answers with the upload's text and the language hint it was given. */
const TRANSCRIBER = `
import { appendFileSync } from 'node:fs';
const [port, log] = process.argv.slice(2);
const note = (line) => appendFileSync(log, line + '\\n');
note('start asr');
process.on('SIGTERM', () => { note('stop asr'); process.exit(0); });
Bun.serve({
  hostname: '127.0.0.1',
  port: Number(port),
  async fetch(request) {
    if (request.method === 'GET') return new Response('ready');
    const form = await request.formData();
    const text = await form.get('file').text();
    if (text === 'boom') return new Response('cannot decode audio', { status: 400 });
    note('transcribe ' + text);
    return Response.json({ lang: form.get('language'), segments: [{ from: 0, to: 1, text }] });
  },
});
`;

/** The gate with one speech engine, the transcriber and the translator, on separate ports. */
async function startBoth(dir: string, free = '12000') {
  const [gatePort, translatePort, enginePort] = [
    await freePort(),
    await freePort(),
    await freePort(),
  ];
  const log = join(dir, 'log');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'engine.ts'), ENGINE);
  writeFileSync(join(dir, 'translator.ts'), TRANSLATOR);
  writeFileSync(join(dir, 'asr.ts'), TRANSCRIBER);
  const bin = fakeTool(dir, 'nvidia-smi', `console.log(${JSON.stringify(free)});`);
  const voice = join(dir, 'en.wav');
  writeFileSync(voice, 'en-audio');
  const config = join(dir, 'gate.json');
  const engine = (command: string[]) => ({ command, directory: dir, environment: {}, vram: 9000 });
  writeFileSync(
    config,
    JSON.stringify({
      enginePort,
      vramWait: 0,
      voices: { anki: { en: { path: voice, text: 'en words' } } },
      routes: { anki: { en: 'one' } },
      engines: {
        one: engine([process.execPath, join(dir, 'engine.ts'), 'one', String(enginePort), log]),
        translator: engine([process.execPath, join(dir, 'translator.ts'), String(enginePort), log]),
        asr: engine([process.execPath, join(dir, 'asr.ts'), String(enginePort), log]),
      },
      translator: 'translator',
      transcriber: 'asr',
    }),
  );
  const gate = Bun.spawn([process.execPath, resolve('src/gate.ts')], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      PORT: String(gatePort),
      TRANSLATE_PORT: String(translatePort),
      GATE_CONFIG: config,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  children.push(gate);
  const base = `http://127.0.0.1:${translatePort}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(`${base}/languages`).catch(() => undefined)) break;
    await Bun.sleep(50);
  }
  const translate = (body: object) =>
    fetch(`${base}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const speak = () => {
    const body = new FormData();
    body.append('text', 'hi');
    body.append('use', 'anki');
    body.append('language', 'en');
    return fetch(`http://127.0.0.1:${gatePort}/v1/audio/speech`, { method: 'POST', body });
  };
  const transcribe = (audio: string, language?: string) => {
    const body = new FormData();
    body.append('file', new Blob([audio]), 'in.m4a');
    if (language) body.append('language', language);
    return fetch(`http://127.0.0.1:${gatePort}/v1/audio/transcriptions`, { method: 'POST', body });
  };
  return { base, speech: `http://127.0.0.1:${gatePort}`, log, translate, speak, transcribe };
}

/** The fields these tests read from LibreTranslate answers. */
interface Answer {
  translatedText?: unknown;
  error?: string;
  info?: { title: string };
}
const answer = async (response: Response) => (await response.json()) as Answer;

describe('translation', () => {
  test('answers like LibreTranslate once the model reports loaded, naming the detected language', async () => {
    const { translate } = await startBoth(scratch());
    const response = await translate({ q: '猫が好き', source: 'auto', target: 'zh' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      translatedText: '[猫が好き]',
      detectedLanguage: { confidence: 90, language: 'ja' },
    });
  });

  test('a list keeps its order and its blank items, which never reach the model', async () => {
    const { log, translate } = await startBoth(scratch());
    const response = await translate({ q: ['one', ' ', 'two'], source: 'en', target: 'ja' });
    expect((await answer(response)).translatedText).toEqual(['[one]', '', '[two]']);
    expect(lines(log).filter((line) => line.startsWith('translate'))).toHaveLength(2);
  });

  test('shares the card with speech: one model leaves before the other loads', async () => {
    const { log, translate, speak } = await startBoth(scratch());
    await speak();
    await translate({ q: 'hello', source: 'en', target: 'zh' });
    await speak();
    expect(lines(log)).toEqual([
      'start one',
      'speak one hi',
      'stop one',
      'start translator',
      'translate hello',
      'stop translator',
      'start one',
      'speak one hi',
    ]);
  });

  test('tells Dialect what it needs before any model loads', async () => {
    const { base, log } = await startBoth(scratch());
    expect((await answer(await fetch(`${base}/spec`))).info?.title).toBe('LibreTranslate');
    const settings = await (await fetch(`${base}/frontend/settings`)).json();
    expect(settings).toMatchObject({ charLimit: 3000, apiKeys: false, keyRequired: false });
    const listed = (await (await fetch(`${base}/languages`)).json()) as { code: string }[];
    const codes = listed.map((language) => language.code);
    expect(codes).toEqual(['en', 'ja', 'zh']);
    const form = new FormData();
    form.append('q', 'hello');
    const detected = await (await fetch(`${base}/detect`, { method: 'POST', body: form })).json();
    expect(detected).toEqual([{ confidence: 90, language: 'en' }]);
    expect(readFileSync(log, 'utf8')).toBe('');
  });

  test('refuses in the words Dialect recognises', async () => {
    const { translate } = await startBoth(scratch());
    const unsupported = await translate({ q: 'hi', source: 'auto', target: 'fr' });
    expect(unsupported.status).toBe(400);
    expect((await answer(unsupported)).error).toBe('fr is not supported');
    const long = await translate({ q: 'a'.repeat(3001), source: 'auto', target: 'zh' });
    expect((await answer(long)).error).toContain('exceeds character limit');
  });

  test('a card held by another job answers an error instead of killing that job', async () => {
    const { log, translate } = await startBoth(scratch(), '100');
    const response = await translate({ q: 'hi', source: 'en', target: 'zh' });
    expect(response.status).toBe(503);
    expect((await answer(response)).error).toContain('Only 100 MiB');
    expect(readFileSync(log, 'utf8')).toBe('');
  });

  test('the speech port does not answer translation, so only translation reaches the tailnet', async () => {
    const { base, speech } = await startBoth(scratch());
    expect((await fetch(`${speech}/languages`)).status).toBe(404);
    expect((await fetch(`${base}/v1/routes`)).status).toBe(404);
  });
});

describe('transcription', () => {
  test('the upload and its language hint reach the transcriber, and its answer comes back', async () => {
    const { transcribe } = await startBoth(scratch());
    const response = await transcribe('words', 'ja');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      lang: 'ja',
      segments: [{ from: 0, to: 1, text: 'words' }],
    });
  });

  test('takes its turn on the card: speech leaves before the transcriber loads', async () => {
    const { log, transcribe, speak } = await startBoth(scratch());
    await speak();
    await Promise.all([transcribe('first'), transcribe('second')]);
    await speak();
    expect(lines(log)).toEqual([
      'start one',
      'speak one hi',
      'stop one',
      'start asr',
      'transcribe first',
      'transcribe second',
      'stop asr',
      'start one',
      'speak one hi',
    ]);
  });

  test("the transcriber's refusal reaches the caller with its status", async () => {
    const { transcribe } = await startBoth(scratch());
    const response = await transcribe('boom');
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('cannot decode audio');
  });

  test('a host without a transcriber says so without loading a model', async () => {
    const { log, url } = await start(scratch());
    const body = new FormData();
    body.append('file', new Blob(['words']), 'in.m4a');
    const response = await fetch(`${url}/v1/audio/transcriptions`, { method: 'POST', body });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('this host does not transcribe');
    expect(readFileSync(log, 'utf8')).toBe('');
  });
});
