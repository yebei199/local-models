// Serve audition pages from a directory on loopback; Caddy adds TLS and the tailnet entry.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { portFromEnvironment } from './backend';
import {
  auditionPage,
  type Entry,
  homePage,
  type Machine,
  parseAudition,
  takeCount,
} from './pages';

/** Pages and their audio change together, so browsers must revalidate; seeking audio needs Range. */
const common = { 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes' };
const html = { ...common, 'Content-Type': 'text/html; charset=utf-8' };

/** Shipped with the server, so these names shadow any same-named path in the page directory. */
const assets: Record<string, string> = {
  '/assets/page.css': join(import.meta.dir, 'web/page.css'),
  '/assets/player.js': join(import.meta.dir, 'web/player.js'),
};

/** Resolve a URL path inside the root. Dot paths stay private, and the real-path check keeps a
 * symlink or an encoded separator from reaching files the tailnet should not read. */
function locate(root: string, pathname: string): string | null {
  try {
    const parts = decodeURIComponent(pathname).split('/').filter(Boolean);
    if (parts.some((part) => part.startsWith('.'))) return null;
    const path = realpathSync(join(root, ...parts));
    return path === root || path.startsWith(root + sep) ? path : null;
  } catch {
    return null;
  }
}

/** A page written as HTML keeps its own title and description. */
async function htmlEntry(file: string, href: string, name: string): Promise<Entry> {
  const head = await Bun.file(file).slice(0, 4096).text();
  const description = head.match(/<meta name="description" content="([^"]*)"/i)?.[1];
  return {
    href,
    title: head.match(/<title>(.+?)<\/title>/is)?.[1]?.trim() ?? name,
    modified: statSync(file).mtime,
    ...(description ? { description } : {}),
  };
}

/** An audition that fails to parse stays listed: its page explains what is wrong. */
async function auditionEntry(file: string, href: string, name: string): Promise<Entry> {
  const modified = statSync(file).mtime;
  try {
    const audition = parseAudition(await Bun.file(file).text());
    return {
      href,
      title: audition.title,
      takes: takeCount(audition),
      modified,
      ...(audition.description ? { description: audition.description } : {}),
    };
  } catch {
    return { href, title: name, description: 'audition.json 有误', modified };
  }
}

/** A page is a top-level `.html` file, or a directory with `audition.json` or `index.html`. */
async function entry(root: string, name: string): Promise<Entry | null> {
  const path = locate(root, name);
  if (!path) return null;
  const href = encodeURIComponent(name);
  if (!statSync(path).isDirectory())
    return path.endsWith('.html') ? htmlEntry(path, href, name) : null;
  if (existsSync(join(path, 'audition.json')))
    return auditionEntry(join(path, 'audition.json'), `${href}/`, name);
  const index = join(path, 'index.html');
  return existsSync(index) ? htmlEntry(index, `${href}/`, name) : null;
}

/** Standard output of a tool, or nothing when it is missing or fails. */
function output(command: string[]): string {
  try {
    const result = Bun.spawnSync(command);
    return result.stdout.toString();
  } catch {
    return '';
  }
}

/** A host without a GPU still serves pages, so a failed probe drops the strip, not the page. */
function machine(): Machine | null {
  const query = [
    'nvidia-smi',
    '--query-gpu=memory.used,memory.total',
    '--format=csv,noheader,nounits',
  ];
  const [usedMib, totalMib] = output(query).split('\n')[0]?.split(',').map(Number) ?? [];
  if (!usedMib || !totalMib) return null;
  const active = (unit: string) =>
    output(['systemctl', '--user', 'is-active', unit]).trim() === 'active';
  return {
    usedMib,
    totalMib,
    speech: active('tts-backend.service'),
    images: active('comfyui-backend.service'),
  };
}

/** The home page is generated, so publishing a page only means copying it into the directory. */
async function home(root: string): Promise<Response> {
  const found = await Promise.all(readdirSync(root).map((name) => entry(root, name)));
  const entries = found
    .filter((item) => item !== null)
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return new Response(homePage(entries, machine()), { headers: html });
}

/** The byte span a Range header asks for: null means the whole file, 'invalid' means 416. */
function span(range: string | null, size: number): [number, number] | 'invalid' | null {
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(size - Number(match[2]), 0);
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start > end || start >= size ? 'invalid' : [start, end];
}

/** Answer with the file or the requested part of it. */
function send(path: string, range: string | null): Response {
  const file = Bun.file(path);
  const headers = { ...common, 'Content-Type': file.type };
  const part = span(range, file.size);
  if (part === null) return new Response(file, { headers });
  if (part === 'invalid')
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${file.size}` },
    });
  const [start, end] = part;
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${file.size}` },
  });
}

/** A broken `audition.json` says what is wrong instead of showing an empty page. */
async function directory(path: string): Promise<Response> {
  const data = join(path, 'audition.json');
  if (existsSync(data)) {
    try {
      const page = auditionPage(parseAudition(await Bun.file(data).text()));
      return new Response(page, { headers: html });
    } catch (error) {
      return new Response(`audition.json: ${String(error)}`, { status: 500 });
    }
  }
  const index = join(path, 'index.html');
  return existsSync(index) ? send(index, null) : new Response('Not found', { status: 404 });
}

/** Route one request; pages use relative audio paths, so directories need their trailing slash. */
async function respond(root: string, request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const { pathname } = new URL(request.url);
  if (pathname === '/') return home(root);
  const asset = assets[pathname];
  if (asset) return send(asset, null);
  const path = locate(root, pathname);
  if (!path) return new Response('Not found', { status: 404 });
  if (!statSync(path).isDirectory()) return send(path, request.headers.get('Range'));
  if (!pathname.endsWith('/'))
    return new Response(null, { status: 308, headers: { Location: `${pathname}/` } });
  return directory(path);
}

if (import.meta.main) {
  try {
    const directory = process.env.WEB_DIR;
    if (!directory) throw new Error('Consumer must supply WEB_DIR');
    const root = realpathSync(directory);
    Bun.serve({
      hostname: '127.0.0.1',
      port: Number(portFromEnvironment()),
      fetch: (request) => respond(root, request),
    });
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
