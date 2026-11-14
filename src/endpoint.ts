// Reach the model gate from any host: directly on the model host, otherwise through an SSH forward.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLocal } from './host.ts';

/** Where requests go, and how to release the route afterwards. */
export interface Endpoint {
  url: string;
  unix?: string;
  close: () => void;
}

/** The port the gate's front listens on, on the model host. */
function port(command: string): string {
  const value = process.env.TTS_PORT;
  if (!value) throw new Error(`${command}: TTS_PORT was not supplied`);
  return value;
}

/** Forward a private unix socket to the gate, so the gate stays bound to loopback. */
async function tunnel(command: string, host: string): Promise<Endpoint> {
  const dir = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), `${command}-`));
  const socket = join(dir, 'forward.sock');
  const ssh = Bun.spawn(
    [
      'ssh',
      '-N',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      `${socket}:127.0.0.1:${port(command)}`,
    ].concat(host),
    { stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' },
  );
  const close = () => {
    ssh.kill();
    rmSync(dir, { recursive: true, force: true });
  };
  for (let attempt = 0; attempt < 300 && ssh.exitCode === null; attempt++) {
    if (existsSync(socket)) return { url: 'http://localhost', unix: socket, close };
    await Bun.sleep(100);
  }
  close();
  throw new Error(`${command}: cannot reach ${host} over ssh`);
}

/** Local callers talk to the front directly; everyone else needs the forward. `command` names the
 * caller in errors. */
export async function connect(command: string, host: string): Promise<Endpoint> {
  if (isLocal(host)) return { url: `http://127.0.0.1:${port(command)}`, close: () => {} };
  return tunnel(command, host);
}
