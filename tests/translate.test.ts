// translate: the command against a fake LibreTranslate service that brackets what it receives.

import { afterAll, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, scratch } from './helpers';

const requests: { q: string[]; source: string; target: string }[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { q: string[]; source: string; target: string };
    requests.push(body);
    if (body.q.some((text) => text.includes('boom')))
      return Response.json({ error: 'Only 100 MiB VRAM free' }, { status: 503 });
    return Response.json({ translatedText: body.q.map((text) => `<${text}>`) });
  },
});
afterAll(() => server.stop(true));

const env = { TRANSLATE_URL: server.url.href };

test('text from arguments goes to stdout', async () => {
  const result = await run('translate', ['--to', 'zh', 'good', 'morning'], env);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('<good morning>\n');
  expect(requests.at(-1)).toMatchObject({ source: 'auto', target: 'zh' });
});

test('a document is translated paragraph by paragraph and keeps its blank lines', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'in.md'), 'First line\nsame paragraph\n\n\n  Second  \n');
  const result = await run(
    'translate',
    ['--to', 'ja', '--from', 'en', '-i', join(dir, 'in.md'), '-o', join(dir, 'out.md')],
    env,
  );
  expect(result.status).toBe(0);
  expect(readFileSync(join(dir, 'out.md'), 'utf8')).toBe(
    '<First line\nsame paragraph>\n\n\n  <Second>  \n',
  );
});

test('subtitles keep their numbers, timings and CRLF; only the cue text is translated', async () => {
  const dir = scratch();
  const srt =
    '1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\nthere\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nBye\r\n';
  writeFileSync(join(dir, 'in.srt'), srt);
  await run(
    'translate',
    ['--to', 'zh', '-i', join(dir, 'in.srt'), '-o', join(dir, 'out.srt')],
    env,
  );
  expect(readFileSync(join(dir, 'out.srt'), 'utf8')).toBe(
    '1\r\n00:00:01,000 --> 00:00:02,000\r\n<Hello\r\nthere>\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n<Bye>\r\n',
  );
});

test('a failed request leaves no output file and reports the service error', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'in.txt'), 'fine\n\nboom\n');
  const result = await run(
    'translate',
    ['--to', 'zh', '-i', join(dir, 'in.txt'), '-o', join(dir, 'out.txt')],
    env,
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Only 100 MiB');
  expect(existsSync(join(dir, 'out.txt'))).toBe(false);
});

test('an unknown target is refused before anything is sent', async () => {
  const before = requests.length;
  const result = await run('translate', ['--to', 'fr', 'hi'], env);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('--to en|ja|zh');
  expect(requests.length).toBe(before);
});
