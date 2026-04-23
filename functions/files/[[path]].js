// functions/files/[[path]].js
// CF Pages Function — serves objects from R2 binding UPLOADS.
// URL pattern: /files/{r2/key/path}
//
// Access control is by key obscurity (submissionId is a 32-hex random UUID).
// CF Access bypass MUST include /files/* for Airtable's attachment-URL fetcher.
//
// Env bindings:
//   UPLOADS (R2 bucket binding)

async function handle({ params, env, request }) {
  if (!env.UPLOADS) {
    return new Response('R2 binding missing', { status: 500 });
  }
  const path = Array.isArray(params.path) ? params.path.join('/') : (params.path || '');
  if (!path) return new Response('Not found', { status: 404 });
  if (path.indexOf('..') !== -1) return new Response('Bad request', { status: 400 });

  const method = request.method;
  if (method === 'HEAD') {
    const head = await env.UPLOADS.head(path);
    if (!head) return new Response(null, { status: 404 });
    const h = new Headers();
    if (head.httpMetadata && head.httpMetadata.contentType) h.set('Content-Type', head.httpMetadata.contentType);
    if (head.size) h.set('Content-Length', String(head.size));
    if (head.etag) h.set('ETag', head.etag);
    h.set('Cache-Control', 'private, max-age=86400');
    return new Response(null, { status: 200, headers: h });
  }

  if (method === 'GET') {
    let obj;
    try {
      obj = await env.UPLOADS.get(path);
    } catch (err) {
      return new Response('Fetch error', { status: 502 });
    }
    if (!obj) return new Response('Not found', { status: 404 });
    const h = new Headers();
    h.set('Content-Type', (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream');
    h.set('Cache-Control', 'private, max-age=86400');
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Content-Disposition', 'inline');
    if (obj.size) h.set('Content-Length', String(obj.size));
    if (obj.etag) h.set('ETag', obj.etag);
    return new Response(obj.body, { status: 200, headers: h });
  }

  return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
}

export function onRequest(context) { return handle(context); }
