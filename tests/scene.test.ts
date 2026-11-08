import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeTool, run, scratch } from './helpers.ts';

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

/** Stand in for ComfyUI: accept one prompt and report a finished image. */
function comfy(): { url: string; prompts: Graph[]; freed: () => boolean } {
  const prompts: Graph[] = [];
  let freed = false;
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === '/prompt') {
        prompts.push(((await request.json()) as { prompt: Graph }).prompt);
        return Response.json({ prompt_id: 'job' });
      }
      if (pathname === '/history/job')
        return Response.json({
          job: { outputs: { '9': { images: [{ filename: 'a.png', type: 'output' }] } } },
        });
      if (pathname === '/view') return new Response('image-bytes');
      if (pathname === '/free') {
        freed = true;
        return new Response('{}');
      }
      return new Response('missing', { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, prompts, freed: () => freed };
}

/** A logging tool that succeeds, so tests can read how it was called. */
function logger(dir: string, name: string, log: string): string {
  return fakeTool(
    dir,
    name,
    `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, '${name} ' + process.argv.slice(2).join(' ') + '\\n');`,
  );
}

test('image generation frees speech VRAM on the model host, then returns the file', async () => {
  const dir = scratch();
  const { url, prompts, freed } = comfy();
  const log = join(dir, 'calls.log');
  const bin = logger(dir, 'ssh', log);
  const output = join(dir, 'o.png');
  const result = await run('scene', ['image', 'a cat', '-o', output, '--seed', '5'], {
    COMFYUI_URL: url,
    TTS_HOST: 'model-host',
    PATH: `${bin}:${process.env.PATH}`,
  });
  expect(result).toMatchObject({ status: 0 });
  expect(readFileSync(log, 'utf8')).toBe(
    'ssh model-host systemctl --user stop tts-backend.service\n',
  );
  expect(readFileSync(output, 'utf8')).toBe('image-bytes');
  expect(String(prompts[0]?.['4']?.inputs.text)).toEndWith('Scene: a cat');
  expect(prompts[0]?.['10']?.inputs.noise_seed).toBe(5);
  expect(freed()).toBe(true);
});

test('on the model host itself the service is stopped without ssh', async () => {
  const dir = scratch();
  const { url } = comfy();
  const log = join(dir, 'calls.log');
  logger(dir, 'ssh', log);
  const bin = logger(dir, 'systemctl', log);
  const result = await run('scene', ['video', 'rain', '-o', join(dir, 'o.mp4'), '--raw'], {
    COMFYUI_URL: url,
    TTS_HOST: '',
    PATH: `${bin}:${process.env.PATH}`,
  });
  expect(result).toMatchObject({ status: 0 });
  expect(readFileSync(log, 'utf8')).toBe('systemctl --user stop tts-backend.service\n');
});

test('failing to stop speech warns and generation continues', async () => {
  const dir = scratch();
  const { url } = comfy();
  const bin = fakeTool(dir, 'systemctl', "console.error('no bus'); process.exit(1);");
  const output = join(dir, 'o.png');
  const result = await run('scene', ['image', 'x', '-o', output], {
    COMFYUI_URL: url,
    TTS_HOST: '',
    PATH: `${bin}:${process.env.PATH}`,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('no bus');
  expect(existsSync(output)).toBe(true);
});

test('a video length off the 17k+5 grid is rejected before any work', async () => {
  const dir = scratch();
  const { prompts, url } = comfy();
  const result = await run('scene', ['video', 'x', '-o', join(dir, 'o.mp4'), '--length', '100'], {
    COMFYUI_URL: url,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('17k+5');
  expect(prompts).toEqual([]);
});

test('a first frame is uploaded and wired into the video graph', async () => {
  const dir = scratch();
  const prompts: Graph[] = [];
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === '/upload/image') return Response.json({ name: 'up.png', subfolder: 's' });
      if (pathname === '/prompt') {
        prompts.push(((await request.json()) as { prompt: Graph }).prompt);
        return Response.json({ prompt_id: 'job' });
      }
      if (pathname === '/history/job')
        return Response.json({ job: { outputs: { '9': { images: [{ filename: 'v.mp4' }] } } } });
      return new Response('{}');
    },
  });
  const frame = join(dir, 'f.png');
  writeFileSync(frame, 'png');
  const bin = fakeTool(dir, 'systemctl', '');
  const result = await run('scene', ['video', 'x', '-o', join(dir, 'o.mp4'), '--image', frame], {
    COMFYUI_URL: `http://127.0.0.1:${server.port}`,
    TTS_HOST: '',
    PATH: `${bin}:${process.env.PATH}`,
  });
  expect(result).toMatchObject({ status: 0 });
  expect(prompts[0]?.['5']?.inputs.image).toBe('s/up.png');
  expect(prompts[0]?.['6']?.inputs.first_frame).toEqual(['5', 0]);
});

test('music fills caption, lyrics, length and both seeds, then converts FLAC to the output type', async () => {
  const dir = scratch();
  const flac = join(dir, 'm.flac');
  const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', flac];
  expect(Bun.spawnSync(['ffmpeg', '-v', 'error', '-y', ...tone]).exitCode).toBe(0);
  const prompts: Graph[] = [];
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === '/prompt') {
        prompts.push(((await request.json()) as { prompt: Graph }).prompt);
        return Response.json({ prompt_id: 'job' });
      }
      if (pathname === '/history/job')
        return Response.json({ job: { outputs: { '13': { audio: [{ filename: 'm.flac' }] } } } });
      if (pathname === '/view') return new Response(Bun.file(flac));
      return new Response('{}');
    },
  });
  const bin = fakeTool(dir, 'systemctl', '');
  const output = join(dir, 'o.wav');
  const result = await run(
    'scene',
    ['music', 'calm lo-fi', '-o', output, '--seconds', '20', '--seed', '7'],
    {
      COMFYUI_URL: `http://127.0.0.1:${server.port}`,
      TTS_HOST: '',
      PATH: `${bin}:${process.env.PATH}`,
    },
  );
  expect(result).toMatchObject({ status: 0 });
  expect(prompts[0]?.['4']?.inputs).toMatchObject({
    caption: 'calm lo-fi',
    lyrics: '[Instrumental]',
    seed: 7,
    max_duration: 20,
  });
  expect(prompts[0]?.['10']?.inputs.seed).toBe(7);
  expect(readFileSync(output).subarray(0, 4).toString()).toBe('RIFF');
});

test('a music length beyond the encoder limit is rejected before any work', async () => {
  const dir = scratch();
  const { prompts, url } = comfy();
  const result = await run('scene', ['music', 'x', '-o', join(dir, 'o.wav'), '--seconds', '400'], {
    COMFYUI_URL: url,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('360');
  expect(prompts).toEqual([]);
});
