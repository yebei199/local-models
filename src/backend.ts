// Start the installed ComfyUI, and gate services on port and VRAM state.
import { paths } from './manifest';

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
  const models = process.env.MODELS;
  const cuda = process.env.CUDA_LIB;
  if (!models || !cuda) throw new Error('Consumer must supply MODELS and CUDA_LIB paths');
  const comfy = paths(models, 'comfyui');
  if (listening(port)) throw new Error(`Port ${port} is already in use`);
  const tail = Bun.spawnSync(['tailscale', 'ip', '-4']);
  const address = tail.exitCode === 0 ? tail.stdout.toString().split('\n')[0]?.trim() : '';
  if (!address) console.error('warn: no Tailscale address; listening only on loopback');
  const child = Bun.spawn(
    [
      comfy.python,
      'main.py',
      // Code and data apart: the pinned checkout is replaceable, models and outputs are not.
      '--base-directory',
      comfy.data,
      '--listen',
      `127.0.0.1${address ? `,${address}` : ''}`,
      '--port',
      port,
      // DynamicVRAM streams weights from disk; --lowvram and friends would switch it off and
      // 28 GB of H3 weights would no longer fit a 16 GB card.
      '--fast-disk',
      // Pinning page-locks up to 90% of RAM; with 31 GB and H3 loaded the host swaps. Costs ~20%.
      '--disable-pinned-memory',
      // Headroom for the display and other processes, so sampling is not squeezed out midway.
      '--reserve-vram',
      '1.5',
      '--preview-method',
      'none',
      '--enable-assets',
      ...process.argv.slice(3),
    ],
    {
      cwd: comfy.code,
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

/** Free MiB on the first GPU. */
function freeVram(): number {
  const p = Bun.spawnSync([
    'nvidia-smi',
    '--query-gpu=memory.free',
    '--format=csv,noheader,nounits',
  ]);
  const free = Number(p.stdout.toString().split('\n')[0]);
  if (p.exitCode || !Number.isFinite(free)) throw new Error('Cannot read free VRAM');
  return free;
}

/** Refuse to start beside a job holding the card, but give a finished one time to let go:
 * ComfyUI's /free answers seconds before the weights actually leave. */
export async function requireVram(needed: number, seconds: number): Promise<void> {
  let free = freeVram();
  for (let waited = 0; free < needed && waited < seconds; waited++) {
    await Bun.sleep(1000);
    free = freeVram();
  }
  if (free < needed) throw new Error(`Only ${free} MiB VRAM free, need ${needed} MiB`);
}

/** The port every port-bound subcommand operates on. */
export function portFromEnvironment(): string {
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
    const [command, needed, seconds] = process.argv.slice(2);
    if (command === 'wait') await wait(portFromEnvironment());
    else if (command === 'start') process.exitCode = await start(portFromEnvironment());
    else if (command === 'vram' && needed && seconds)
      await requireVram(Number(needed), Number(seconds));
    else throw new Error('Usage: backend start|wait|vram MIB SECONDS');
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
