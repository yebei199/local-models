// Open independent desktop windows and close only their recorded process groups.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Keep the existing runtime marker name so old windows can still be cleared. */
function marker(): string {
  return join(
    process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`,
    'scene-show-windows',
  );
}

/** A detached child leads its process group; group checks avoid command-line self-matches. */
function clear(): void {
  let pids: number[];
  try {
    pids = readFileSync(marker(), 'utf8').trim().split('\n').map(Number);
  } catch {
    pids = [];
  }
  let closed = 0;
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    try {
      process.kill(pid, 0);
      process.kill(-pid, 0);
      process.kill(-pid, 'SIGTERM');
      closed++;
    } catch {
      /* Exited or reused processes without the recorded group are ignored. */
    }
  }
  rmSync(marker(), { force: true });
  console.log(closed ? `关掉了 ${closed} 个窗口` : '没有开着的窗口');
}

/** Resolve spawn readiness before reporting a window as opened. */
async function show(path: string): Promise<void> {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`找不到文件: ${path}`);
  const video = /\.(mp4|webm|mkv|mov)$/i.test(path);
  const child = spawn(
    'mpv',
    [
      `--title=scene-show: ${basename(path)}`,
      '--no-terminal',
      video ? '--loop-file=inf' : '--image-display-duration=inf',
      path,
    ],
    { detached: true, stdio: 'ignore' },
  );
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  try {
    appendFileSync(marker(), `${child.pid}\n`);
  } catch (error) {
    console.error(`warn: window opened but PID could not be recorded: ${String(error)}`);
  }
  console.log(`已开窗口显示${video ? '视频' : '图'} ${path}(pid ${child.pid})`);
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1) throw new Error('Usage: scene-show FILE | --clear');
    const path = args[0];
    if (path === undefined) throw new Error('Missing path');
    if (path === '--clear') clear();
    else await show(path);
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
