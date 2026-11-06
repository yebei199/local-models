// Route speech requests to the right model, keeping only one on the GPU at a time.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { requireVram } from './backend.ts';

/** A cold start costs about 35 seconds on Breeze; anything past this is a hung load. */
const START_TIMEOUT = 300_000;
const STOP_TIMEOUT = 30_000;

/** How to run one model; every engine answers the Breeze speech contract on `enginePort`. */
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
  /** Reference per language: a clone reads best from a reference in its own language. */
  voices: Record<string, { path: string; text: string }>;
  routes: Record<string, Record<string, string>>;
  engines: Record<string, Engine>;
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
  for (const routes of Object.values(config.routes))
    for (const [language, engine] of Object.entries(routes)) {
      if (!config.engines[engine]) throw new Error(`gate: route names unknown engine ${engine}`);
      if (!config.voices[language]) throw new Error(`gate: no voice for language ${language}`);
    }
  return config;
}

/** Ask politely first: a model that ignores SIGTERM must still give the card back. */
async function terminate(process: Bun.Subprocess): Promise<void> {
  process.kill('SIGTERM');
  const timer = setTimeout(() => process.kill('SIGKILL'), STOP_TIMEOUT);
  await process.exited;
  clearTimeout(timer);
}

/** Any HTTP answer means the model finished loading, because it binds only after that. */
async function ready(port: number, process: Bun.Subprocess): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`engine exited with ${process.exitCode}`);
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      await Bun.sleep(200);
    }
  }
  throw new Error('engine did not start in time');
}

/** The form an engine sees: the caller's voice if it sent one, otherwise the language's voice. */
function engineForm(request: Incoming, config: Config, language: string): FormData {
  const body = new FormData();
  body.append('text', String(request.get('text')));
  body.append('language', language);
  for (const name of ['instruction', 'seed']) {
    const value = request.get(name);
    if (typeof value === 'string') body.append(name, value);
  }
  const audio = request.get('ref_audio');
  const custom = audio instanceof File;
  const voice = config.voices[language] as Config['voices'][string];
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

  async function synthesize(name: string, body: FormData): Promise<Response> {
    await activate(name);
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
  function enqueue(name: string, body: FormData): Promise<Response> {
    const result = queue.then(() => synthesize(name, body));
    queue = result.catch(() => {});
    return result;
  }

  async function handle(request: Request): Promise<Response> {
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
      return await enqueue(name, engineForm(form, config, language));
    } catch (error) {
      return new Response(String(error), { status: 503 });
    }
  }

  return { handle, stop };
}

if (import.meta.main) {
  const path = process.env.GATE_CONFIG;
  const port = process.env.PORT;
  if (!path || !port) throw new Error('gate: GATE_CONFIG and PORT must be supplied');
  const { handle, stop } = gate(loadConfig(path));
  Bun.serve({ hostname: '127.0.0.1', port: Number(port), idleTimeout: 0, fetch: handle });
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.on(signal, () => {
      stop().finally(() => process.exit(0));
    });
}
