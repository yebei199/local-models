// Transcribe an audio file into timed subtitle lines through the model gate, from any host.
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { connect } from './endpoint.ts';

/** A warm run takes about 45 seconds per hour of audio; this covers two hours behind a model swap. */
const REQUEST_TIMEOUT = 900_000;

const LANGUAGES = ['en', 'ja', 'zh'];

interface Task {
  audio: string;
  output: string;
  lang?: string;
}

/** A line of the transcript, in seconds. */
interface Segment {
  from: number;
  to: number;
  text: string;
  lang?: string;
}

/** Check the arguments before anything reaches the model host. */
function task(args: string[]): Task {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { output: { type: 'string', short: 'o' }, lang: { type: 'string' } },
  });
  const [command, audio, ...extra] = positionals;
  if (command !== 'transcribe' || !audio || extra.length || !values.output)
    throw new Error('Usage: asr transcribe <audio> -o <out.json> [--lang en|ja|zh]');
  if (!existsSync(audio)) throw new Error(`asr: ${audio} does not exist`);
  if (values.lang !== undefined && !LANGUAGES.includes(values.lang))
    throw new Error(`asr: lang must be one of ${LANGUAGES.join(', ')}`);
  return { audio, output: values.output, lang: values.lang };
}

/** An answer without a segment list is a broken service, not an empty transcript. */
function checked(body: unknown): { segments: Segment[] } {
  const segments = (body as { segments?: unknown } | null)?.segments;
  if (!Array.isArray(segments)) throw new Error('asr: service returned no segment list');
  return body as { segments: Segment[] };
}

/** Write only after the whole answer arrived, so a failure leaves no partial transcript. */
async function main(args: string[]): Promise<void> {
  const { audio, output, lang } = task(args);
  const body = new FormData();
  body.append('file', new Blob([readFileSync(audio)]), basename(audio));
  if (lang) body.append('language', lang);
  const endpoint = await connect('asr', process.env.TTS_HOST ?? '');
  try {
    const response = await fetch(`${endpoint.url}/v1/audio/transcriptions`, {
      method: 'POST',
      body,
      unix: endpoint.unix,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!response.ok)
      throw new Error(`asr: service answered ${response.status}: ${await response.text()}`);
    const transcript = checked(await response.json());
    await Bun.write(output, `${JSON.stringify(transcript, null, 1)}\n`);
    console.log(`Transcribed: ${output} (${transcript.segments.length} lines)`);
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
