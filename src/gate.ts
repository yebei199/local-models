// Route speech, transcription and translation requests to the right model, keeping only one on the GPU at a time.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { requireVram } from './backend.ts';
import { libre } from './libre.ts';

/** A cold start costs about 35 seconds on Breeze; anything past this is a hung load. */
const START_TIMEOUT = 300_000;
const STOP_TIMEOUT = 30_000;

/** A recording and its exact transcript. */
interface Voice {
  path: string;
  text: string;
}

/** How to run one model on `enginePort`: speech engines answer the Breeze speech contract, the
 * transcriber takes an audio upload and answers timed lines, the translator answers OpenAI chat
 * completions. */
interface Engine {
  command: string[];
  directory: string;
  environment: Record<string, string>;
  vram: number;
}

interface Config {
  enginePort: number;
  /** Seconds a finished job gets to release the card before a start is refused. */
  vramWait: number;
  /**
   * Reference per use and language. A clone reads best from a reference in its own language, and
   * it copies the reference's delivery, so narration and flashcards need different recordings.
   */
  voices: Record<string, Record<string, Voice>>;
  routes: Record<string, Record<string, string>>;
  engines: Record<string, Engine>;
  /** The engine behind the translation port, if this host translates. */
  translator?: string;
  /** The engine behind `/v1/audio/transcriptions`, if this host transcribes. */
  transcriber?: string;
}

/** A parsed request body; Bun and the DOM type FormData differently. */
type Incoming = Awaited<ReturnType<Request['formData']>>;

/** The model holding the GPU now. */
interface Active {
  name: string;
  process: Bun.Subprocess;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A route naming a missing engine or voice is a deployment mistake, so it fails at start, not mid-batch. */
function loadConfig(path: string): Config {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(value) || !isRecord(value.routes) || !isRecord(value.engines))
    throw new Error('gate: config needs routes and engines');
  if (!isRecord(value.voices)) throw new Error('gate: config needs voices');
  const config = value as unknown as Config;
  for (const [use, routes] of Object.entries(config.routes))
    for (const [language, engine] of Object.entries(routes)) {
      if (!config.engines[engine]) throw new Error(`gate: route names unknown engine ${engine}`);
      if (!config.voices[use]?.[language]) throw new Error(`gate: no voice for ${use}/${language}`);
    }
  for (const role of ['translator', 'transcriber'] as const) requireEngine(config, role);
  return config;
}

function requireEngine(config: Config, role: 'translator' | 'transcriber'): void {
  const name = config[role];
  if (name && !config.engines[name]) throw new Error(`gate: unknown ${role} ${name}`);
}

/** Ask politely first: a model that ignores SIGTERM must still give the card back. */
async function terminate(process: Bun.Subprocess): Promise<void> {
  process.kill('SIGTERM');
  const timer = setTimeout(() => process.kill('SIGKILL'), STOP_TIMEOUT);
  await process.exited;
  clearTimeout(timer);
}

/** The speech engines bind only after loading, so any answer means ready; llama-server binds
 * first and answers 503 on /health until its weights are on the card. */
async function ready(port: number, process: Bun.Subprocess): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`engine exited with ${process.exitCode}`);
    const answer = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    }).catch(() => undefined);
    if (answer && answer.status !== 503) return;
    await Bun.sleep(200);
  }
  throw new Error('engine did not start in time');
}

/** The form an engine sees: the caller's voice if it sent one, otherwise the route's voice. */
function engineForm(request: Incoming, voice: Voice, language: string): FormData {
  const body = new FormData();
  body.append('text', String(request.get('text')));
  body.append('language', language);
  for (const name of ['instruction', 'seed']) {
    const value = request.get(name);
    if (typeof value === 'string') body.append(name, value);
  }
  const audio = request.get('ref_audio');
  const custom = audio instanceof File;
  body.append('ref_text', custom ? String(request.get('ref_text')) : voice.text);
  body.append(
    'ref_audio',
    custom ? audio : new Blob([readFileSync(voice.path)], { type: 'audio/wav' }),
    custom ? audio.name : basename(voice.path),
  );
  return body;
}

/** Build the request handler and the shutdown hook around one piece of GPU state. */
function gate(config: Config) {
  let active: Active | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  async function stop(): Promise<void> {
    const current = active;
    active = undefined;
    if (current) await terminate(current.process);
  }

  /** The old model leaves before the new one loads; two never fit together. */
  async function activate(name: string): Promise<void> {
    if (active?.name === name) return;
    await stop();
    const engine = config.engines[name] as Engine;
    await requireVram(engine.vram, config.vramWait);
    const process = Bun.spawn(engine.command, {
      cwd: engine.directory,
      env: { ...Bun.env, ...engine.environment },
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const started = { name, process };
    active = started;
    process.exited.then(() => {
      if (active === started) active = undefined;
    });
    try {
      await ready(config.enginePort, process);
    } catch (error) {
      await stop();
      throw error;
    }
  }

  async function synthesize(body: FormData): Promise<Response> {
    const response = await fetch(`http://127.0.0.1:${config.enginePort}/v1/audio/speech`, {
      method: 'POST',
      body,
    });
    const headers = new Headers();
    const rate = response.headers.get('X-Sample-Rate');
    if (rate) headers.set('X-Sample-Rate', rate);
    return new Response(await response.arrayBuffer(), { status: response.status, headers });
  }

  /** Requests wait their turn here, so callers never see the single-GPU limit. */
  function enqueue<T>(name: string, job: () => Promise<T>): Promise<T> {
    const result = queue.then(async () => {
      await activate(name);
      return job();
    });
    queue = result.catch(() => {});
    return result;
  }

  /** One queue turn for a whole batch: the segments run together, and llama-server spreads them
   * over its parallel slots. */
  function complete(name: string, bodies: object[]): Promise<string[]> {
    return enqueue(name, () =>
      Promise.all(
        bodies.map(async (body) => {
          const response = await fetch(
            `http://127.0.0.1:${config.enginePort}/v1/chat/completions`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            },
          );
          if (!response.ok) throw new Error(`translator: ${await response.text()}`);
          const answer = (await response.json()) as {
            choices: { message: { content: string } }[];
          };
          return answer.choices[0]?.message.content ?? '';
        }),
      ),
    );
  }

  /** The upload is buffered before it queues: a stream left waiting behind another job would
   * stall the caller's connection. The engine answers when the whole file is transcribed. */
  async function transcribe(request: Request, name: string): Promise<Response> {
    const headers = { 'Content-Type': request.headers.get('Content-Type') ?? '' };
    const body = await request.arrayBuffer();
    try {
      return await enqueue(name, async () => {
        const response = await fetch(
          `http://127.0.0.1:${config.enginePort}/v1/audio/transcriptions`,
          { method: 'POST', body, headers, timeout: false },
        );
        return new Response(await response.arrayBuffer(), {
          status: response.status,
          headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'text/plain' },
        });
      });
    } catch (error) {
      return new Response(String(error), { status: 503 });
    }
  }

  async function speech(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/v1/routes') return Response.json(config.routes);
    if (request.method !== 'POST' || path !== '/v1/audio/speech')
      return new Response('not found', { status: 404 });
    const form = await request.formData();
    const use = String(form.get('use'));
    const language = String(form.get('language'));
    const name = config.routes[use]?.[language];
    if (!name) return new Response(`no route for ${use}/${language}`, { status: 400 });
    try {
      const voice = config.voices[use]?.[language] as Voice;
      const body = engineForm(form, voice, language);
      return await enqueue(name, () => synthesize(body));
    } catch (error) {
      return new Response(String(error), { status: 503 });
    }
  }

  /** The loopback port behind ssh: speech and transcription share it, since both stay off the
   * tailnet. */
  function local(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || path !== '/v1/audio/transcriptions') return speech(request);
    if (!config.transcriber)
      return Promise.resolve(new Response('this host does not transcribe', { status: 404 }));
    return transcribe(request, config.transcriber);
  }

  const translator = config.translator;
  const translate = translator ? libre((bodies) => complete(translator, bodies)).handle : undefined;
  return { speech: local, translate, stop };
}

if (import.meta.main) {
  const path = process.env.GATE_CONFIG;
  const port = process.env.PORT;
  if (!path || !port) throw new Error('gate: GATE_CONFIG and PORT must be supplied');
  const { speech, translate, stop } = gate(loadConfig(path));
  Bun.serve({ hostname: '127.0.0.1', port: Number(port), idleTimeout: 0, fetch: speech });
  // Translation has its own port because only it is published on the tailnet; speech stays on
  // loopback behind ssh.
  const translatePort = process.env.TRANSLATE_PORT;
  if (translate && translatePort)
    Bun.serve({
      hostname: '127.0.0.1',
      port: Number(translatePort),
      idleTimeout: 0,
      fetch: translate,
    });
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.on(signal, () => {
      stop().finally(() => process.exit(0));
    });
}
