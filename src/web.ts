// Serve audition pages from a directory on loopback; Caddy adds TLS and the tailnet entry.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { portFromEnvironment } from './backend';

/** Pages and their audio change together, so browsers must revalidate; seeking audio needs Range. */
const common = { 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes' };

interface Page {
  href: string;
  title: string;
  modified: Date;
}

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

/** A page is a top-level `.html` file, or a directory holding `index.html`. */
async function page(root: string, name: string): Promise<Page | null> {
  const path = locate(root, name);
  if (!path) return null;
  const directory = statSync(path).isDirectory();
  const html = directory ? join(path, 'index.html') : path;
  if (!html.endsWith('.html') || !existsSync(html)) return null;
  const head = await Bun.file(html).slice(0, 4096).text();
  return {
    href: `${encodeURIComponent(name)}${directory ? '/' : ''}`,
    title: head.match(/<title>(.+?)<\/title>/is)?.[1]?.trim() ?? name,
    modified: statSync(html).mtime,
  };
}

/** The home page is generated, so publishing a page only means copying it into the directory.
 * Titles come from page files, so they are escaped as text. */
async function home(root: string): Promise<Response> {
  const found = await Promise.all(readdirSync(root).map((name) => page(root, name)));
  const pages = found
    .filter((item) => item !== null)
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
  const rows = pages.map(
    (item) =>
      `<li><a href="${Bun.escapeHTML(item.href)}">${Bun.escapeHTML(item.title)}</a>` +
      `<time>${item.modified.toISOString().slice(0, 10)}</time></li>`,
  );
  const body = rows.length ? `<ul>${rows.join('')}</ul>` : '<p>还没有页面。</p>';
  const html = `<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>本地模型</title>
<style>:root{color-scheme:light dark}body{font:16px/1.6 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}
ul{list-style:none;padding:0}li{display:flex;justify-content:space-between;gap:1rem;padding:.6rem 0;border-bottom:1px solid #8884}
time{opacity:.6;font-variant-numeric:tabular-nums}</style><h1>本地模型</h1>${body}</html>`;
  return new Response(html, {
    headers: { ...common, 'Content-Type': 'text/html; charset=utf-8' },
  });
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

/** Route one request; pages use relative audio paths, so directories need their trailing slash. */
async function respond(root: string, request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const { pathname } = new URL(request.url);
  if (pathname === '/') return home(root);
  const path = locate(root, pathname);
  if (!path) return new Response('Not found', { status: 404 });
  if (!statSync(path).isDirectory()) return send(path, request.headers.get('Range'));
  if (!pathname.endsWith('/'))
    return new Response(null, { status: 308, headers: { Location: `${pathname}/` } });
  const index = join(path, 'index.html');
  return existsSync(index) ? send(index, null) : new Response('Not found', { status: 404 });
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
