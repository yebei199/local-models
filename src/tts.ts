// Speak text through the Breeze-TTS-2 service, directly on the model host or over an SSH forward.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isLocal } from './host.ts';
import { wav } from './wav.ts';

/** Cold start alone costs about 35 seconds, and one request may queue behind another. */
const REQUEST_TIMEOUT = 600_000;

/** Breeze clones a voice only from reference audio plus its exact transcript. */
interface Voice {
  path: string;
  text: string;
}

/** One utterance and the file it becomes. */
interface Task {
  text: string;
  output: string;
  voice: Voice;
  instruction?: string;
  seed?: string;
}

/** Where requests go, and how to release the route afterwards. */
interface Endpoint {
  url: string;
  unix?: string;
  close: () => void;
}

/** The port the service front listens on, on the model host. */
function port(): string {
  const value = process.env.TTS_PORT;
  if (!value) throw new Error('tts: TTS_PORT was not supplied');
  return value;
}

/** Forward a private unix socket to the service, so the service stays bound to loopback. */
async function tunnel(host: string): Promise<Endpoint> {
  const dir = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), 'tts-'));
  const socket = join(dir, 'forward.sock');
  const ssh = Bun.spawn(
    ['ssh', '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `${socket}:127.0.0.1:${port()}`, host],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' },
  );
  const close = () => {
    ssh.kill();
    rmSync(dir, { recursive: true, force: true });
  };
  for (let attempt = 0; attempt < 300 && ssh.exitCode === null; attempt++) {
    if (existsSync(socket)) return { url: 'http://localhost', unix: socket, close };
    await Bun.sleep(100);
  }
  close();
  throw new Error(`tts: cannot reach ${host} over ssh`);
}

/** Local callers talk to the front directly; everyone else needs the forward. */
async function connect(host: string): Promise<Endpoint> {
  if (isLocal(host)) return { url: `http://127.0.0.1:${port()}`, close: () => {} };
  return tunnel(host);
}

/** Build the multipart body; a FormData cannot be replayed once a request consumed it. */
function form(task: Task): FormData {
  const body = new FormData();
  body.append('text', task.text);
  body.append('ref_text', task.voice.text);
  body.append(
    'ref_audio',
    new Blob([readFileSync(task.voice.path)], { type: 'audio/wav' }),
    basename(task.voice.path),
  );
  if (task.instruction) body.append('instruction', task.instruction);
  if (task.seed) body.append('seed', task.seed);
  return body;
}

/** The service runs one request at a time and answers 409 to the rest, so callers queue here. */
async function post(endpoint: Endpoint, task: Task): Promise<Response> {
  const deadline = Date.now() + REQUEST_TIMEOUT;
  while (true) {
    const response = await fetch(`${endpoint.url}/v1/audio/speech`, {
      method: 'POST',
      body: form(task),
      unix: endpoint.unix,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (response.status !== 409 || Date.now() > deadline) return response;
    await Bun.sleep(1000);
  }
}

/** Write the file only after the whole stream arrived, so a failure leaves no partial audio. */
async function synthesize(endpoint: Endpoint, task: Task): Promise<void> {
  const response = await post(endpoint, task);
  if (!response.ok)
    throw new Error(`tts: service answered ${response.status}: ${await response.text()}`);
  const sampleRate = Number(response.headers.get('X-Sample-Rate'));
  const pcm = await response.arrayBuffer();
  if (!sampleRate || !pcm.byteLength) throw new Error('tts: service returned no audio');
  await Bun.write(task.output, wav(pcm, sampleRate));
  console.log(`Generated: ${task.output}`);
}

/** Pair an explicit voice with its transcript, or fall back to the configured default. */
function voice(path: string | undefined, text: string | undefined): Voice {
  if (Boolean(path) !== Boolean(text))
    throw new Error('tts: a voice needs both the audio file and its exact transcript');
  const resolved = {
    path: path || process.env.TTS_VOICE || '',
    text: text || process.env.TTS_VOICE_TEXT || '',
  };
  if (!resolved.path || !resolved.text) throw new Error('tts: default voice was not supplied');
  return resolved;
}

/** `tts synth`: one utterance from flags. */
function synthTask(args: string[]): Task[] {
  const { values } = parseArgs({
    args,
    options: {
      text: { type: 'string' },
      output: { type: 'string' },
      voice: { type: 'string' },
      'voice-text': { type: 'string' },
      instruction: { type: 'string' },
      seed: { type: 'string' },
    },
  });
  if (!values.text || !values.output) throw new Error('tts: synth needs --text and --output');
  return [
    {
      text: values.text,
      output: values.output,
      voice: voice(values.voice, values['voice-text']),
      instruction: values.instruction,
      seed: values.seed,
    },
  ];
}

/** Read one JSONL row; relative paths belong to the manifest's directory. */
function batchRow(line: string, base: string): Task {
  const row: unknown = JSON.parse(line);
  if (!row || typeof row !== 'object') throw new Error(`tts: bad batch row: ${line}`);
  const { text, output, voice: path, voice_text: voiceText } = row as Record<string, unknown>;
  if (typeof text !== 'string' || typeof output !== 'string' || !text || !output)
    throw new Error(`tts: batch row needs text and output: ${line}`);
  if (![path, voiceText].every((value) => value === undefined || typeof value === 'string'))
    throw new Error(`tts: batch voice fields must be strings: ${line}`);
  return {
    text,
    output: resolve(base, output),
    voice: voice(
      typeof path === 'string' ? resolve(base, path) : undefined,
      voiceText as string | undefined,
    ),
  };
}

/** `tts batch`: every row is validated before the first one costs GPU time. */
function batchTasks(args: string[]): Task[] {
  const { values } = parseArgs({ args, options: { 'batch-file': { type: 'string' } } });
  const manifest = values['batch-file'];
  if (!manifest) throw new Error('tts: batch needs --batch-file');
  const lines = readFileSync(manifest, 'utf8')
    .split('\n')
    .filter((line) => line.trim());
  return lines.map((line) => batchRow(line, dirname(resolve(manifest))));
}

/** Parse everything first, then hold one route open for all utterances. */
async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command !== 'synth' && command !== 'batch')
    throw new Error('Usage: tts synth|batch [options]');
  const tasks = command === 'synth' ? synthTask(rest) : batchTasks(rest);
  const endpoint = await connect(process.env.TTS_HOST ?? '');
  try {
    for (const task of tasks) await synthesize(endpoint, task);
  } finally {
    endpoint.close();
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
