// Speak text through the model gate, directly on the model host or over an SSH forward.
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { connect, type Endpoint } from './endpoint.ts';
import { wav } from './wav.ts';

/** Cold start alone costs about 35 seconds, and one request may queue behind another. */
const REQUEST_TIMEOUT = 600_000;

const USES = ['anki', 'video'];
const LANGUAGES = ['en', 'ja', 'zh'];

/** An explicit voice needs reference audio plus its exact transcript. */
interface Voice {
  path: string;
  text: string;
}

/** One utterance and the file it becomes. */
interface Task {
  text: string;
  output: string;
  use: string;
  lang: string;
  voice?: Voice;
  instruction?: string;
  seed?: string;
}

/** Build the multipart body; the gate fills in the fixed voice when none is given. */
function form(task: Task): FormData {
  const body = new FormData();
  body.append('text', task.text);
  body.append('use', task.use);
  body.append('language', task.lang);
  if (task.voice) {
    body.append('ref_text', task.voice.text);
    body.append(
      'ref_audio',
      new Blob([readFileSync(task.voice.path)], { type: 'audio/wav' }),
      basename(task.voice.path),
    );
  }
  if (task.instruction) body.append('instruction', task.instruction);
  if (task.seed) body.append('seed', task.seed);
  return body;
}

/** Write the file only after the whole stream arrived, so a failure leaves no partial audio. */
async function synthesize(endpoint: Endpoint, task: Task): Promise<void> {
  const response = await fetch(`${endpoint.url}/v1/audio/speech`, {
    method: 'POST',
    body: form(task),
    unix: endpoint.unix,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (!response.ok)
    throw new Error(`tts: service answered ${response.status}: ${await response.text()}`);
  const sampleRate = Number(response.headers.get('X-Sample-Rate'));
  const pcm = await response.arrayBuffer();
  if (!sampleRate || !pcm.byteLength) throw new Error('tts: service returned no audio');
  await Bun.write(task.output, wav(pcm, sampleRate));
  console.log(`Generated: ${task.output}`);
}

/** A voice is optional, but its audio and transcript only make sense together. */
function voice(path: string | undefined, text: string | undefined): Voice | undefined {
  if (Boolean(path) !== Boolean(text))
    throw new Error('tts: a voice needs both the audio file and its exact transcript');
  return path && text ? { path, text } : undefined;
}

/** The language is required: text cannot reveal it, and a wrong guess reads aloud without error. */
function route(use: unknown, lang: unknown): { use: string; lang: string } {
  const resolved = use ?? 'anki';
  if (typeof resolved !== 'string' || !USES.includes(resolved))
    throw new Error(`tts: use must be one of ${USES.join(', ')}`);
  if (typeof lang !== 'string' || !LANGUAGES.includes(lang))
    throw new Error(`tts: lang is required and must be one of ${LANGUAGES.join(', ')}`);
  return { use: resolved, lang };
}

/** `tts synth`: one utterance from flags. */
function synthTask(args: string[]): Task[] {
  const { values } = parseArgs({
    args,
    options: {
      text: { type: 'string' },
      output: { type: 'string' },
      use: { type: 'string' },
      lang: { type: 'string' },
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
      ...route(values.use, values.lang),
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
  const {
    text,
    output,
    use,
    lang,
    voice: path,
    voice_text: voiceText,
    instruction,
    seed,
  } = row as Record<string, unknown>;
  if (typeof text !== 'string' || typeof output !== 'string' || !text || !output)
    throw new Error(`tts: batch row needs text and output: ${line}`);
  // A seed parsed as a JSON number would silently lose digits, so it travels as a string.
  const optional = [path, voiceText, instruction, seed];
  if (!optional.every((value) => value === undefined || typeof value === 'string'))
    throw new Error(`tts: batch voice, instruction and seed fields must be strings: ${line}`);
  return {
    text,
    output: resolve(base, output),
    ...route(use, lang),
    voice: voice(
      typeof path === 'string' ? resolve(base, path) : undefined,
      voiceText as string | undefined,
    ),
    instruction: instruction as string | undefined,
    seed: seed as string | undefined,
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

/** Only the gate knows which model serves a route; grouping by it loads each model once. */
async function grouped(endpoint: Endpoint, tasks: Task[]): Promise<Task[]> {
  if (tasks.length < 2) return tasks;
  const response = await fetch(`${endpoint.url}/v1/routes`, { unix: endpoint.unix });
  if (!response.ok) throw new Error(`tts: cannot read routes: ${response.status}`);
  const routes = (await response.json()) as Record<string, Record<string, string>>;
  const engine = (task: Task) => routes[task.use]?.[task.lang] ?? '';
  return tasks.toSorted((a, b) => engine(a).localeCompare(engine(b)));
}

/** Parse everything first, then hold one route open for all utterances. */
async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command !== 'synth' && command !== 'batch')
    throw new Error('Usage: tts synth|batch [options]');
  const tasks = command === 'synth' ? synthTask(rest) : batchTasks(rest);
  const endpoint = await connect('tts', process.env.TTS_HOST ?? '');
  try {
    for (const task of await grouped(endpoint, tasks)) await synthesize(endpoint, task);
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
