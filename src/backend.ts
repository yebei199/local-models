// Start ComfyUI from its external environment, and gate model services on port and VRAM state.
import { join } from 'node:path';

/** The clock and probe seams bound cold-start waiting without slowing local contract tests. */
async function waitBackend(probe: () => boolean, sleep: () => Promise<void>): Promise<boolean> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (probe()) return true;
    await sleep();
  }
  return false;
}

/** Resolve readiness from the same local listening-socket query used by the old script. */
function listening(port: string): boolean {
  const p = Bun.spawnSync(['ss', '-tln', `sport = :${port}`]);
  return p.exitCode === 0 && p.stdout.toString().includes(`:${port}`);
}

/** Forward service termination to the inference child while retaining its exit status. */
async function start(port: string): Promise<number> {
  const project = process.env.COMFYUI_DIR;
  const cuda = process.env.CUDA_LIB;
  if (!project || !cuda)
    throw new Error('Consumer must supply ComfyUI project and CUDA library paths');
  if (listening(port)) throw new Error(`Port ${port} is already in use`);
  const tail = Bun.spawnSync(['tailscale', 'ip', '-4']);
  const address = tail.exitCode === 0 ? tail.stdout.toString().split('\n')[0]?.trim() : '';
  if (!address) console.error('warn: no Tailscale address; listening only on loopback');
  const child = Bun.spawn(
    [
      join(project, 'ComfyUI/.venv/bin/python'),
      'main.py',
      '--listen',
      `127.0.0.1${address ? `,${address}` : ''}`,
      '--port',
      port,
      '--fast-disk',
      '--disable-pinned-memory',
      '--reserve-vram',
      '1.5',
      '--preview-method',
      'none',
      '--enable-assets',
      ...process.argv.slice(3),
    ],
    {
      cwd: join(project, 'ComfyUI'),
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `${cuda}${process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''}`,
      },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  const terminate = () => child.kill('SIGTERM');
  const interrupt = () => child.kill('SIGINT');
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  try {
    return await child.exited;
  } finally {
    process.off('SIGTERM', terminate);
    process.off('SIGINT', interrupt);
  }
}

/** Refuse to start beside a job that holds the card: an OOM here has locked the screen before. */
function requireVram(needed: string): void {
  const p = Bun.spawnSync([
    'nvidia-smi',
    '--query-gpu=memory.free',
    '--format=csv,noheader,nounits',
  ]);
  const free = Number(p.stdout.toString().split('\n')[0]);
  if (p.exitCode || !Number.isFinite(free)) throw new Error('Cannot read free VRAM');
  if (free < Number(needed)) throw new Error(`Only ${free} MiB VRAM free, need ${needed} MiB`);
}

/** The port every port-bound subcommand operates on. */
function portFromEnvironment(): string {
  const port = process.env.PORT;
  if (!port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error('Consumer must supply a valid PORT');
  return port;
}

/** Wait for the service to bind, one probe a second. */
async function wait(port: string): Promise<void> {
  const bound = await waitBackend(
    () => listening(port),
    () => Bun.sleep(1000),
  );
  if (!bound) throw new Error(`Nothing bound ${port} within 300 seconds`);
}

if (import.meta.main) {
  try {
    const [command, value] = process.argv.slice(2);
    if (command === 'wait') await wait(portFromEnvironment());
    else if (command === 'start') process.exitCode = await start(portFromEnvironment());
    else if (command === 'vram' && value) requireVram(value);
    else throw new Error('Usage: backend start|wait|vram MIB');
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
