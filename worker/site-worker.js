// The web game's static files. Cloudflare's asset server answers a Range request with the whole
// file, and iPhones will not play a video without a real partial answer, so media goes through here.
// Every other file is served directly (run_worker_first in wrangler-site.jsonc).

/** { start, end } for one byte range, null to send the whole file, 'bad' when it cannot be met. */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // none, several ranges, or another unit
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return 'bad';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) return 'bad';
  return { start, end };
}

export async function serveMedia(request, assets) {
  const range = request.headers.get('Range');
  const plain = new Request(request.url, { method: 'GET', headers: { Accept: request.headers.get('Accept') || '*/*' } });
  const res = await assets.fetch(plain);
  if (res.status !== 200) return res;

  const headers = new Headers(res.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.delete('Content-Encoding');
  if (request.method === 'HEAD' && !range) return new Response(null, { status: 200, headers });
  if (!range) return new Response(res.body, { status: 200, headers });
  const ifRange = request.headers.get('If-Range');
  if (ifRange && ifRange !== res.headers.get('ETag')) return new Response(res.body, { status: 200, headers });

  const body = await res.arrayBuffer();
  const part = parseRange(range, body.byteLength);
  if (part === null) {
    headers.set('Content-Length', String(body.byteLength));
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
  }
  if (part === 'bad') {
    headers.set('Content-Range', `bytes */${body.byteLength}`);
    headers.delete('Content-Length');
    return new Response(null, { status: 416, headers });
  }
  headers.set('Content-Range', `bytes ${part.start}-${part.end}/${body.byteLength}`);
  headers.set('Content-Length', String(part.end - part.start + 1));
  return new Response(request.method === 'HEAD' ? null : body.slice(part.start, part.end + 1), { status: 206, headers });
}

export default {
  fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return env.ASSETS.fetch(request);
    if (/\.(mp4|webm|mov|m4v|mp3|m4a|ogg|wav)$/i.test(new URL(request.url).pathname)) return serveMedia(request, env.ASSETS);
    return env.ASSETS.fetch(request);
  },
};
