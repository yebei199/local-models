// The model host decides whether a command acts here or crosses SSH.
import { hostname } from 'node:os';

/** An empty host means this machine, and so does the model host naming itself. */
export function isLocal(host: string): boolean {
  return !host || host === hostname();
}
