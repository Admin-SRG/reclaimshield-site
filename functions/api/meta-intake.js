// functions/api/meta-intake.js
// CF Pages Function — ReclaimShield Meta intake (with R2 file upload).
// 1) Parses multipart/form-data (text fields + 3 file upload groups).
// 2) Verifies Turnstile token server-side.
// 3) Uploads each file to R2 binding (UPLOADS) with submissionId-prefixed keys.
// 4) Forwards metadata + R2 file URLs (same-origin /files/...) to Make webhook.
//
// Env bindings required:
//   TURNSTILE_SECRET (Secret, shared with /api/verify)
//   UPLOADS          (R2 bucket binding — bind to 'sentinel-uploads')
//
// Webhook URL is hardcoded (Turnstile is the gate; matches amazon-intake.js pattern).

const META_WEBHOOK_URL = 'https://hook.us2.make.com/ens2snsjy3vqaf4oxqeb4ba67t7c0luo';
const FILE_FIELDS = ['noticeScreenshots', 'contentScreenshots', 'supportingDocuments'];
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain'
]);

function sanitize(s, maxLen) {
  if (typeof s !== 'string') return '';
  var cleaned = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  if (cleaned.length > maxLen) cleaned = cleaned.slice(0, maxLen);
  return cleaned;
}
function sanitizeFilename(name) {
  return (name || 'file')
    .replace(/[\\/\x00-\x1F\x7F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9._\-]/g, '_')
    .slice(0, 200) || 'file';
}
function newId() {
  var a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

async function onRequestPost({ request, env }) {
  const origin = new URL(request.url).origin;
  const cors = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
    'Content-Type': 'application/json'
  };

  if (!env.TURNSTILE_SECRET) {
    return new Response(JSON.stringify({ error: 'server_misconfigured_turnstile' }), { status: 500, headers: cors });
  }
  if (!env.UPLOADS) {
    return new Response(JSON.stringify({ error: 'server_misconfigured_r2' }), { status: 500, headers: cors });
  }

  let fd;
  try {
    fd = await request.formData();
  } catch (_e) {
    return new Response(JSON.stringify({ error: 'invalid_multipart' }), { status: 400, headers: cors });
  }

  const token = fd.get('turnstileToken');
  if (!token || typeof token !== 'string' || token.length < 20) {
    return new Response(JSON.stringify({ error: 'missing_turnstile_token' }), { status: 400, headers: cors });
  }

  // Verify Turnstile
  const clientIp = request.headers.get('CF-Connecting-IP') || '';
  const vb = new FormData();
  vb.append('secret', env.TURNSTILE_SECRET);
  vb.append('response', token);
  if (clientIp) vb.append('remoteip', clientIp);
  let vj;
  try {
    const vr = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: vb });
    vj = await vr.json();
  } catch (_e) {
    return new Response(JSON.stringify({ error: 'verify_network_error' }), { status: 502, headers: cors });
  }
  if (!vj || vj.success !== true) {
    return new Response(JSON.stringify({ error: 'turnstile_failed', codes: vj ? (vj['error-codes'] || []) : [] }), { status: 403, headers: cors });
  }

  // Collect text fields (sanitize). Mirrors the meta-intake.html form payload contract.
  const textFields = {};
  const textKeys = [
    'sessionId', 'clientName', 'email', 'phone', 'country',
    'platform', 'issueType', 'violationCategory',
    'accountUsername', 'accountDescription',
    'revenueBucket', 'appealDeadline', 'clientAddress',
    'disclosureAck',
    'intakeAppealStatusUS', 'intakeInternalComplaintEU', 'intakeAceEU',
    'intakeDisclosureVersion', 'intakeUserAgent', 'intakeTimestamp'
  ];
  for (const k of textKeys) {
    const v = fd.get(k);
    if (v !== null) textFields[k] = sanitize(String(v), 10000);
  }

  // Minimum validation
  if (!textFields.clientName || textFields.clientName.length < 2) {
    return new Response(JSON.stringify({ error: 'invalid_client_name' }), { status: 400, headers: cors });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(textFields.email || '')) {
    return new Response(JSON.stringify({ error: 'invalid_email' }), { status: 400, headers: cors });
  }
  if (textFields.disclosureAck !== 'true') {
    return new Response(JSON.stringify({ error: 'disclosure_ack_required' }), { status: 400, headers: cors });
  }

  // Upload files to R2
  const submissionId = newId();
  const uploads = {};
  for (const field of FILE_FIELDS) {
    uploads[field] = [];
    const files = fd.getAll(field);
    for (const f of files) {
      if (!(f instanceof File) || !f.size) continue;
      if (f.size > MAX_FILE_BYTES) {
        return new Response(JSON.stringify({ error: 'file_too_large', field, name: f.name, size: f.size }), { status: 413, headers: cors });
      }
      const mime = f.type || 'application/octet-stream';
      if (mime !== 'application/octet-stream' && !ALLOWED_MIME.has(mime)) {
        const ext = (f.name || '').split('.').pop().toLowerCase();
        const extOk = ['pdf','jpg','jpeg','png','gif','webp','doc','docx','xls','xlsx','txt'].includes(ext);
        if (!extOk) {
          return new Response(JSON.stringify({ error: 'file_type_rejected', field, name: f.name, type: mime }), { status: 415, headers: cors });
        }
      }
      const safeName = sanitizeFilename(f.name);
      const key = 'meta/' + submissionId + '/' + field + '/' + newId().slice(0, 8) + '_' + safeName;
      try {
        await env.UPLOADS.put(key, f.stream(), {
          httpMetadata: { contentType: mime },
          customMetadata: {
            submissionId: submissionId,
            field: field,
            originalName: f.name || 'file',
            customerEmail: textFields.email || '',
            uploadedAt: new Date().toISOString()
          }
        });
        uploads[field].push({
          name: f.name,
          size: f.size,
          type: mime,
          key: key,
          url: origin + '/files/' + key
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'r2_upload_failed', field, name: f.name, detail: String(err).slice(0, 200) }), { status: 502, headers: cors });
      }
    }
  }

  // Build forward payload — preserves all text fields + adds submissionId, uploads, audit metadata.
  const payload = Object.assign({}, textFields, {
    submissionId: submissionId,
    verifiedAt: new Date().toISOString(),
    clientIp: clientIp,
    turnstileHost: (vj && vj.hostname) || '',
    turnstileChallengeTs: (vj && vj.challenge_ts) || '',
    uploads: uploads,
    fileCount: FILE_FIELDS.reduce(function (n, f) { return n + uploads[f].length; }, 0),
    // Pre-flattened URL arrays for Make-side mapping convenience.
    noticeScreenshotUrls: uploads.noticeScreenshots.map(function (u) { return u.url; }).join('\n'),
    contentScreenshotUrls: uploads.contentScreenshots.map(function (u) { return u.url; }).join('\n'),
    supportingDocUrls: uploads.supportingDocuments.map(function (u) { return u.url; }).join('\n')
  });

  // Forward to Make webhook
  let makeResp;
  try {
    makeResp = await fetch(META_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (_e) {
    return new Response(JSON.stringify({ error: 'webhook_network_error' }), { status: 502, headers: cors });
  }

  return new Response(JSON.stringify({
    ok: makeResp.ok,
    status: makeResp.status,
    submissionId: submissionId,
    fileCount: payload.fileCount
  }), { status: makeResp.ok ? 200 : 502, headers: cors });
}

async function onRequestOptions({ request }) {
  const origin = new URL(request.url).origin;
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
}

export async function onRequest(context) {
  const m = context.request.method;
  if (m === 'POST') return onRequestPost(context);
  if (m === 'OPTIONS') return onRequestOptions(context);
  return new Response('Method Not Allowed', { status: 405, headers: { 'Allow': 'POST, OPTIONS' } });
}
