// Submit the frozen Klein/H3/Music3 workflows and return their media without retaining GPU weights.
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { isLocal } from './host.ts';
import templates from './workflows.json';

/** ComfyUI's node graph remains JSON data; callers may change only the documented inputs. */
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/** H3 decoding accepts only its training frame grid within the existing memory bound. */
function validLength(length: number): boolean {
  return Number.isInteger(length) && length >= 5 && length <= 209 && (length - 5) % 17 === 0;
}

/** Music3's text encoder caps generation at 9000 frames of 25 per second. */
const MAX_MUSIC_SECONDS = 360;

/** Clone frozen graphs before modifying request-specific fields. */
function workflow(kind: Kind, r: SceneRequest, firstFrame?: string): Graph {
  const graph: Graph = structuredClone(templates[kind]);
  const inputs = (id: string): Record<string, unknown> => {
    const node = graph[id];
    if (!node) throw new Error(`Missing workflow node ${id}`);
    return node.inputs;
  };
  const { prompt, width, height, seed } = r;
  if (kind === 'music') {
    // The autoregressive encoder and the sampler draw from separate generators; one seed fixes both.
    Object.assign(inputs('4'), {
      caption: prompt,
      lyrics: r.lyrics,
      seed,
      max_duration: r.seconds,
    });
    inputs('10').seed = seed;
  } else if (kind === 'image') {
    inputs('10').noise_seed = seed;
    inputs('4').text = prompt;
    for (const key of ['6', '7']) Object.assign(inputs(key), { width, height });
  } else {
    inputs('10').noise_seed = seed;
    Object.assign(inputs('6'), { prompt, width, height, length: r.length });
    if (firstFrame) {
      graph['5'] = {
        class_type: 'LoadImage',
        inputs: { image: firstFrame },
      };
      inputs('6').first_frame = ['5', 0];
    }
  }
  return graph;
}

/** Keep the arbitrary-precision seed accepted by the former Python CLI. */
function seedInteger(value: string): bigint {
  if (!/^[+-]?[0-9]+$/.test(value.trim())) throw new Error('Seed must be an integer');
  return BigInt(value.trim());
}

/** Bun raw JSON emits large integer tokens without converting them through Number. */
function rawInteger(value: bigint): unknown {
  if (!('rawJSON' in JSON) || typeof JSON.rawJSON !== 'function')
    throw new Error('Bun must support JSON.rawJSON for integer seeds');
  return JSON.rawJSON(value.toString());
}

/** Surface backend response bodies so rejected node parameters stay diagnosable. */
async function request(
  server: string,
  path: string,
  data?: unknown,
  timeout = 30000,
): Promise<Response> {
  const response = await fetch(`${server}${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
    body:
      data === undefined
        ? undefined
        : JSON.stringify(data, (_key, value: unknown) =>
            typeof value === 'bigint' ? rawInteger(value) : value,
          ),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response;
}

/** Validate only the response shapes that the client needs. */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid ComfyUI response');
  return value as Record<string, unknown>;
}

/** SaveImage and SaveVideo report under `images`, the audio savers under `audio`. */
function firstOutput(value: unknown): Record<string, unknown> {
  const entry = record(value);
  if (entry.status && record(entry.status).status_str === 'error')
    throw new Error(`execution error: ${JSON.stringify(entry.status)}`);
  for (const item of Object.values(record(entry.outputs || {}))) {
    const files = record(item).images ?? record(item).audio;
    if (Array.isArray(files) && files.length) return record(files[0]);
  }
  throw new Error('Execution finished without an output file');
}

/** Upload a distinct first-frame name and use the backend's actual returned name. */
async function upload(server: string, path: string): Promise<string> {
  const form = new FormData();
  form.append(
    'image',
    new Blob([readFileSync(path)], { type: 'image/png' }),
    `anki_frame_${randomUUID().replaceAll('-', '').slice(0, 8)}.png`,
  );
  const response = await fetch(`${server}/upload/image`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`upload: ${await response.text()}`);
  const result = record(await response.json());
  if (typeof result.name !== 'string') throw new Error('Invalid upload filename');
  return result.subfolder ? `${String(result.subfolder)}/${result.name}` : result.name;
}

/** Resident speech holds 8 GiB that diffusion needs; a failure to free it is only a warning. */
async function stopSpeech(host: string): Promise<void> {
  const stop = ['systemctl', '--user', 'stop', 'tts-backend.service'];
  try {
    const p = Bun.spawn(isLocal(host) ? stop : ['ssh', host, ...stop], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const message = await new Response(p.stderr).text();
    if (await p.exited) console.error(`warn: cannot stop speech service: ${message.trim()}`);
  } catch (error) {
    console.error(`warn: ${String(error)}`);
  }
}

/** Poll through startup connection failures but bound the complete wait. */
async function history(server: string, id: string, seconds: number): Promise<unknown> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    let response: Response;
    try {
      response = await request(server, `/history/${encodeURIComponent(id)}`);
    } catch {
      /* Cold startup can temporarily refuse connections. */
      await Bun.sleep(3000);
      continue;
    }
    const result = record(await response.json());
    if (Object.hasOwn(result, id)) return result[id];
    await Bun.sleep(3000);
  }
  throw new Error(`Timeout: no output within ${seconds}s`);
}

type Kind = 'image' | 'video' | 'music';

/** Per-kind CLI defaults; a style prefix is prepended to non-raw image and video prompts. */
const DEFAULTS: Record<Kind, { width: number; height: number; timeout: number; style?: string }> = {
  image: { width: 1536, height: 1024, timeout: 600, style: templates.imageStyle },
  video: { width: 864, height: 480, timeout: 1200, style: templates.videoStyle },
  music: { width: 0, height: 0, timeout: 900 },
};

/** A fully validated generation request. */
interface SceneRequest {
  output: string;
  prompt: string;
  width: number;
  height: number;
  seed: number | bigint;
  length: number;
  seconds: number;
  lyrics: string;
  timeout: number;
  server: string;
  image?: string;
  ttsHost: string;
}

/** Reject request shapes the frozen graphs cannot run before any GPU work starts. */
function validate(kind: Kind, r: SceneRequest): void {
  if (kind === 'video' && !validLength(r.length))
    throw new Error(`Frame length ${r.length} must be 17k+5 and at most 209`);
  if (kind === 'music' && !(r.seconds > 0 && r.seconds <= MAX_MUSIC_SECONDS))
    throw new Error(`Music seconds must be in (0, ${MAX_MUSIC_SECONDS}]`);
  if (kind === 'music' && !extname(r.output))
    throw new Error('The music output needs an extension such as .wav or .flac');
  if (![r.width, r.height, r.timeout].every(Number.isInteger))
    throw new Error('Dimensions seed and timeout must be numeric');
}

/** The user-facing CLI keeps the old defaults, aliases and raw-prompt override. */
function parseRequest(kind: Kind, args: string[]): SceneRequest {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      output: { type: 'string', short: 'o' },
      seed: { type: 'string' },
      raw: { type: 'boolean' },
      server: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      length: { type: 'string' },
      timeout: { type: 'string' },
      image: { type: 'string' },
      seconds: { type: 'string' },
      lyrics: { type: 'string' },
      'tts-host': { type: 'string' },
    },
  });
  if (positionals.length !== 1 || !values.output)
    throw new Error('Provide one scene and --output FILE');
  const defaults = DEFAULTS[kind];
  const scene = positionals[0] ?? '';
  const r: SceneRequest = {
    output: values.output,
    prompt: values.raw || !defaults.style ? scene : `${defaults.style}\n\nScene: ${scene}`,
    width: Number(values.width ?? defaults.width),
    height: Number(values.height ?? defaults.height),
    seed: values.seed === undefined ? randomInt(2 ** 32) : seedInteger(values.seed),
    length: Number(values.length ?? 124),
    seconds: Number(values.seconds ?? 30),
    lyrics: values.lyrics ?? '[Instrumental]',
    timeout: Number(values.timeout ?? defaults.timeout),
    server: (values.server ?? process.env.COMFYUI_URL ?? '').replace(/\/$/, ''),
    image: values.image,
    ttsHost: values['tts-host'] ?? process.env.TTS_HOST ?? '',
  };
  validate(kind, r);
  return r;
}

/** Fetch the produced file's bytes through ComfyUI's view endpoint. */
async function download(server: string, output: Record<string, unknown>): Promise<ArrayBuffer> {
  if (typeof output.filename !== 'string') throw new Error('Invalid output filename');
  const query = new URLSearchParams({
    filename: output.filename,
    subfolder: String(output.subfolder || ''),
    type: String(output.type || 'output'),
  });
  return (await request(server, `/view?${query}`, undefined, 300000)).arrayBuffer();
}

/** Weight release is best effort; the output is already on disk. */
async function releaseWeights(server: string): Promise<void> {
  try {
    await request(server, '/free', {
      unload_models: true,
      free_memory: true,
    });
  } catch (error) {
    console.error(`warn: cannot release weights: ${String(error)}`);
  }
}

/** ComfyUI saves audio only as FLAC, so ffmpeg converts by the output's extension; the
 * result is renamed into place so a failed conversion leaves no partial file. */
function writeAudio(bytes: ArrayBuffer, output: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'scene-music-'));
  const part = join(dirname(output), `.${basename(output)}.part${extname(output)}`);
  try {
    const source = join(dir, 'music.flac');
    writeFileSync(source, Buffer.from(bytes));
    const p = Bun.spawnSync(['ffmpeg', '-v', 'error', '-y', '-i', source, part]);
    if (p.exitCode) throw new Error(`ffmpeg: ${p.stderr.toString().trim()}`);
    renameSync(part, output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(part, { force: true });
  }
}

/** Submit one scene, wait for its output and write it to the requested file. */
async function main(args: string[]): Promise<void> {
  const kind = args.shift();
  if (kind !== 'image' && kind !== 'video' && kind !== 'music')
    throw new Error('Usage: scene image|video|music SCENE -o FILE');
  const r = parseRequest(kind, args);
  await stopSpeech(r.ttsHost);
  const firstFrame = r.image ? await upload(r.server, r.image) : undefined;
  const graph = workflow(kind, r, firstFrame);
  const submitted = record(await (await request(r.server, '/prompt', { prompt: graph })).json());
  if (typeof submitted.prompt_id !== 'string') throw new Error('Invalid prompt id');
  console.log(`已提交: ${submitted.prompt_id} (seed=${r.seed})`);
  const output = firstOutput(await history(r.server, submitted.prompt_id, r.timeout));
  const bytes = await download(r.server, output);
  if (kind === 'music') writeAudio(bytes, r.output);
  else writeFileSync(r.output, Buffer.from(bytes));
  await releaseWeights(r.server);
  console.log(`产出: ${r.output} (${statSync(r.output).size} 字节)`);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
