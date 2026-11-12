// setup: what one config file turns into on a host, with systemctl and the GPU tools faked on PATH.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fakeTool, scratch } from './helpers';

/** A model host like pc3: Breeze, Qwen and Ming but no Irodori or tiny, ComfyUI, and the web pages. */
const modelHost = {
  host: 'pc3',
  models: '/srv/models',
  comfyui: { url: 'https://pc3.example:18088', serve: true },
  web: {},
  tts: {
    voices: { anki: { en: { path: '/srv/en.wav', text: 'Hi.' } } },
    engines: { breeze: {}, qwen: {}, ming: { requiredVram: 5000 } },
  },
};

interface Host {
  home: string;
  log: string;
  run: (config: object, active?: string[]) => Promise<{ status: number; out: string }>;
  file: (path: string) => string;
}

/** A fresh home whose systemctl records its calls and reports `active` units as running. */
function host(): Host {
  const dir = scratch();
  const home = join(dir, 'home');
  const log = join(dir, 'systemctl.log');
  mkdirSync(home);
  const record = `require('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
const args = process.argv.slice(2);
if (args.includes('is-active')) process.exit((process.env.ACTIVE ?? '').split(',').includes(args.at(-1)) ? 0 : 3);`;
  fakeTool(dir, 'systemctl', record);
  for (const name of ['nvidia-smi', 'ss', 'sox', 'tailscale']) fakeTool(dir, name, '');
  const path = `${join(dir, 'bin')}:${process.env.PATH}`;
  return {
    home,
    log,
    file: (path) => readFileSync(join(home, path), 'utf8'),
    async run(config, active = []) {
      mkdirSync(join(home, '.config/local-models'), { recursive: true });
      writeFileSync(join(home, '.config/local-models/config.json'), JSON.stringify(config));
      const child = Bun.spawn([process.execPath, resolve('src/setup.ts')], {
        env: { PATH: path, HOME: home, ACTIVE: active.join(',') },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { status, out: stdout + stderr };
    },
  };
}

const units = '.config/systemd/user';

describe('model host', () => {
  test('writes the units that run each service from this checkout', async () => {
    const h = host();
    expect((await h.run(modelHost)).status).toBe(0);
    const backend = h.file(`${units}/tts-backend.service`);
    expect(backend).toContain(`ExecStart=${Bun.which('bun')} ${resolve('src/gate.ts')} --`);
    expect(backend).toContain('StopWhenUnneeded=true');
    expect(backend).toContain('SuccessExitStatus=143');
    expect(backend).toContain('NO_PROXY=127.0.0.1,localhost');
    expect(h.file(`${units}/tts.socket`)).toContain('ListenStream=127.0.0.1:8290');
    const front = h.file(`${units}/tts.service`);
    expect(front).toContain('--exit-idle-time=30min 127.0.0.1:8291');
    expect(front).not.toContain('/nix/store/');
    expect(backend).not.toContain('/nix/store/');
    const comfy = h.file(`${units}/comfyui-backend.service`);
    expect(comfy).toContain('MODELS=/srv/models');
    expect(comfy).toContain('WorkingDirectory=/srv/models/comfyui/code');
    const web = h.file(`${units}/local-models-web.service`);
    expect(web).toContain(`WEB_DIR=${join(h.home, '.local/share/local-models/web')}`);
    expect(web).toContain(`WEB_UI=${resolve('web/dist')}`);
  });

  test('routes only to the engines the host has', async () => {
    const h = host();
    await h.run(modelHost);
    const gate = JSON.parse(h.file('.local/state/local-models/gate.json'));
    expect(Object.keys(gate.engines).sort()).toEqual(['breeze', 'ming', 'qwen']);
    expect(gate.routes.anki).toEqual({ en: 'breeze', zh: 'breeze' });
    expect(gate.engines.qwen.command).toContain(resolve('engines/qwen.py'));
    expect(gate.engines.qwen.command).toContain('/srv/models/qwen/weights');
    expect(gate.engines.breeze.command[0]).toBe('/srv/models/breeze/venv/bin/python');
    expect(gate.engines.ming.vram).toBe(5000);
    expect(gate.engines.qwen.environment.TRITON_LIBCUDA_PATH).toBe('/run/opengl-driver/lib');
    expect(gate.voices).toEqual(modelHost.tts.voices);
  });

  test('tiny runs from Ming checkout and venv with its own packages first', async () => {
    const h = host();
    const engines = { irodori: {}, 'ming-tiny': { bits: 4 } };
    await h.run({ ...modelHost, tts: { ...modelHost.tts, engines } });
    const gate = JSON.parse(h.file('.local/state/local-models/gate.json'));
    const tiny = gate.engines['ming-tiny'];
    expect(tiny.command.slice(0, 1)).toEqual(['/srv/models/ming/venv/bin/python']);
    expect(tiny.command.join(' ')).toContain('--model /srv/models/ming-tiny/weights --bits 4');
    expect(tiny.environment.PYTHONPATH).toBe(
      '/srv/models/ming-tiny/packages:/srv/models/ming/code',
    );
    expect(gate.engines.irodori.command.join(' ')).toContain(
      '--checkpoint /srv/models/irodori/weights/model.safetensors --codec /srv/models/irodori/weights/codec.pth',
    );
  });

  test('starts the sockets and the web service but never restarts a model unit', async () => {
    const h = host();
    await h.run(modelHost);
    const calls = readFileSync(h.log, 'utf8');
    expect(calls).toContain('--user daemon-reload');
    expect(calls).toContain(
      '--user enable --now comfyui.socket tts.socket local-models-web.service',
    );
    expect(calls).toContain('--user restart local-models-web.service');
    expect(calls.match(/restart/g)).toHaveLength(1);
  });

  test('reports a changed unit that is still running instead of restarting it', async () => {
    const h = host();
    await h.run(modelHost);
    const changed = { ...modelHost, idleTime: '45min' };
    const { out } = await h.run(changed, ['tts.service']);
    expect(out).toContain('tts.service changed and still runs the old definition');
    expect(readFileSync(h.log, 'utf8')).not.toContain('restart tts');
  });
});

describe('translation', () => {
  const translating = {
    ...modelHost,
    translate: { url: 'https://pc3.example:18098', serve: true },
  };

  test('a socket in the tailnet range fronts the gate on its own port', async () => {
    const h = host();
    expect((await h.run(translating)).status).toBe(0);
    expect(h.file(`${units}/translate.socket`)).toContain('ListenStream=127.0.0.1:8098');
    const front = h.file(`${units}/translate.service`);
    expect(front).toContain('Requires=tts-backend.service');
    expect(front).toContain('--exit-idle-time=30min 127.0.0.1:8293');
    expect(h.file(`${units}/tts-backend.service`)).toContain('TRANSLATE_PORT=8293');
    expect(readFileSync(h.log, 'utf8')).toContain('translate.socket');
  });

  test('the gate runs the pinned llama-server on the shared engine port', async () => {
    const h = host();
    await h.run(translating);
    const gate = JSON.parse(h.file('.local/state/local-models/gate.json'));
    expect(gate.translator).toBe('translator');
    const { command, environment, vram } = gate.engines.translator;
    expect(command.slice(0, 3)).toEqual([
      '/srv/models/translator/code/llama-server',
      '-m',
      '/srv/models/translator/weights/model.gguf',
    ]);
    expect(command.join(' ')).toContain('--port 8292');
    expect(environment.LD_LIBRARY_PATH).toBe('/srv/models/translator/code:/run/opengl-driver/lib');
    expect(vram).toBe(10500);
  });

  test('a host that only translates still gets the gate, without speech routes', async () => {
    const h = host();
    expect((await h.run({ translate: { serve: true } })).status).toBe(0);
    const gate = JSON.parse(h.file('.local/state/local-models/gate.json'));
    expect(Object.keys(gate.engines)).toEqual(['translator']);
    expect(gate.routes).toEqual({});
  });

  test('the command carries the tailnet URL', async () => {
    const h = host();
    await h.run({ host: 'pc3', translate: { url: 'https://pc3.example:18098' } });
    expect(h.file('.local/bin/translate')).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion, not a template
      'export TRANSLATE_URL="${TRANSLATE_URL-https://pc3.example:18098}"',
    );
    expect(existsSync(join(h.home, units, 'translate.socket'))).toBe(false);
  });
});

describe('commands', () => {
  test('carry the model host as a default the caller can override', async () => {
    const h = host();
    await h.run({ host: 'pc3', comfyui: { url: 'https://pc3.example:18088' } });
    const tts = h.file('.local/bin/tts');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion, not a template
    expect(tts).toContain('export TTS_HOST="${TTS_HOST-pc3}"');
    expect(tts).toContain(`'${resolve('src/tts.ts')}' -- "$@"`);
    expect(h.file('.local/bin/scene-video')).toContain('scene.ts\' -- video "$@"');
  });

  test('an explicitly empty host still means this machine', async () => {
    const h = host();
    await h.run({ host: 'pc3' });
    const shim = h.file('.local/bin/tts').replace(/^exec .*$/m, 'echo "[$TTS_HOST]"');
    const run = (env: Record<string, string>) =>
      Bun.spawnSync(['sh', '-c', shim], { env }).stdout.toString().trim();
    expect(run({})).toBe('[pc3]');
    expect(run({ TTS_HOST: '' })).toBe('[]');
  });

  test('a client gets commands and no services', async () => {
    const h = host();
    expect((await h.run({ host: 'pc3' })).status).toBe(0);
    expect(existsSync(join(h.home, units))).toBe(false);
    expect(readFileSync(h.log, 'utf8')).not.toContain('enable');
  });
});

describe('refusals', () => {
  test('a file setup did not write stays and nothing is written', async () => {
    const h = host();
    mkdirSync(join(h.home, units), { recursive: true });
    writeFileSync(join(h.home, units, 'tts.socket'), '[Socket]\n');
    const { status, out } = await h.run(modelHost);
    expect(status).toBe(1);
    expect(out).toContain('tts.socket');
    expect(h.file(`${units}/tts.socket`)).toBe('[Socket]\n');
    expect(existsSync(join(h.home, '.local/bin/tts'))).toBe(false);
  });

  test('a missing config says where to write it', async () => {
    const h = host();
    const child = Bun.spawnSync([process.execPath, resolve('src/setup.ts')], {
      env: { PATH: process.env.PATH ?? '', HOME: h.home },
    });
    expect(child.exitCode).toBe(1);
    expect(child.stderr.toString()).toContain('.config/local-models/config.json');
  });

  test('a model host without engines fails by field name', async () => {
    const h = host();
    const { status, out } = await h.run({ tts: { voices: {}, engines: {} } });
    expect(status).toBe(1);
    expect(out).toContain('tts.engines');
  });

  test('a config from before installs moved in names the retired keys', async () => {
    const h = host();
    const { status, out } = await h.run({ comfyui: { directory: '/srv/explore' } });
    expect(status).toBe(1);
    expect(out).toContain('comfyui.directory');
  });
});
