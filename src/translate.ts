// Translate text, documents and subtitles through the model host's LibreTranslate API.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { parseArgs } from 'node:util';
import { CHAR_LIMIT } from './libre.ts';

/** A cold start plus a long document queued behind another caller. */
const REQUEST_TIMEOUT = 600_000;
/** Segments per request: enough to keep both llama-server slots busy, small enough to report. */
const CHUNK = 16;
const LANGUAGES = ['en', 'ja', 'zh'];

/** One piece of the input: kept verbatim, or translated with its surrounding blanks kept. */
interface Piece {
  text: string;
  translate: boolean;
}

/** Leading and trailing blanks stay outside the request, so layout survives translation. */
function piece(text: string): Piece[] {
  const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/) as RegExpMatchArray;
  const [, head = '', core = '', tail = ''] = match;
  if (!core) return [{ text, translate: false }];
  return [
    { text: head, translate: false },
    { text: core, translate: true },
    { text: tail, translate: false },
  ];
}

/** A block too long for one request is split at line breaks; a single line beyond the limit is
 * refused rather than cut mid-sentence. */
function bounded(block: string): Piece[] {
  if (block.length <= CHAR_LIMIT) return piece(block);
  return block.split(/(?<=\n)/).flatMap((line) => {
    if (line.length > CHAR_LIMIT)
      throw new Error(`translate: a line exceeds ${CHAR_LIMIT} characters: ${line.slice(0, 40)}…`);
    return piece(line);
  });
}

/** Subtitle cues keep their number and timing lines; blocks without timing (the WEBVTT header,
 * NOTE) stay as they are. */
function cue(block: string): Piece[] {
  const lines = block.split('\n');
  const timing = lines.findIndex((line) => line.includes('-->'));
  if (timing < 0) return [{ text: block, translate: false }];
  const head = `${lines.slice(0, timing + 1).join('\n')}\n`;
  return [{ text: head, translate: false }, ...bounded(lines.slice(timing + 1).join('\n'))];
}

/** Paragraphs (or cues) are the unit of translation; the blank lines between them stay. */
export function pieces(content: string, subtitles: boolean): Piece[] {
  return content.split(/(\n[ \t]*\n\s*)/).flatMap((part, index) => {
    if (index % 2) return [{ text: part, translate: false }];
    return subtitles ? cue(part) : bounded(part);
  });
}

/** Send every translatable piece, a chunk per request, and only then return the whole text. */
async function run(all: Piece[], to: string, from: string): Promise<string> {
  const url = process.env.TRANSLATE_URL;
  if (!url) throw new Error('translate: TRANSLATE_URL was not supplied; set translate.url');
  const work = all.filter((item) => item.translate);
  for (let start = 0; start < work.length; start += CHUNK) {
    const chunk = work.slice(start, start + CHUNK);
    const response = await fetch(`${url.replace(/\/$/, '')}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: chunk.map((item) => item.text), source: from, target: to }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    const answer = (await response.json().catch(() => ({}))) as {
      translatedText?: unknown;
      error?: string;
    };
    const out = answer.translatedText;
    if (!response.ok || !Array.isArray(out) || out.length !== chunk.length)
      throw new Error(`translate: service answered ${response.status}: ${answer.error ?? ''}`);
    chunk.forEach((item, index) => {
      item.text = String(out[index]);
    });
    if (work.length > CHUNK)
      console.error(`translate: ${Math.min(start + CHUNK, work.length)}/${work.length}`);
  }
  return all.map((item) => item.text).join('');
}

/** The input file, stdin, or the arguments themselves. */
async function source(input: string | undefined, words: string[]): Promise<string> {
  if (input) return readFileSync(input, 'utf8');
  if (words.length) return words.join(' ');
  return await new Response(Bun.stdin.stream()).text();
}

async function main(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      to: { type: 'string' },
      from: { type: 'string' },
      input: { type: 'string', short: 'i' },
      output: { type: 'string', short: 'o' },
    },
  });
  const { to, from = 'auto', input, output } = values;
  if (!to || !LANGUAGES.includes(to))
    throw new Error(
      `Usage: translate --to ${LANGUAGES.join('|')} [--from L] [-i FILE -o FILE | TEXT]`,
    );
  if (from !== 'auto' && !LANGUAGES.includes(from))
    throw new Error(`translate: --from must be auto or one of ${LANGUAGES.join(', ')}`);
  if (Boolean(input) !== Boolean(output)) throw new Error('translate: -i and -o go together');
  const raw = await source(input, positionals);
  // Subtitle files are often CRLF; split on LF and put the line ending back at the end.
  const crlf = raw.includes('\r\n');
  const content = crlf ? raw.replaceAll('\r\n', '\n') : raw;
  const subtitles = ['.srt', '.vtt'].includes(extname(input ?? '').toLowerCase());
  const plan = pieces(content, subtitles);
  const done = await run(plan, to, from);
  const result = crlf ? done.replaceAll('\n', '\r\n') : done;
  // Written only after every piece came back, so a failure leaves no half-translated file.
  if (output) await Bun.write(output, result);
  else process.stdout.write(result.endsWith('\n') ? result : `${result}\n`);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
