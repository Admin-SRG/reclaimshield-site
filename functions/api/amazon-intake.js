// functions/api/amazon-intake.js
// CF Pages Function — Amazon Seller POA intake.
// 1) Parses multipart/form-data (text fields + 4 file upload groups).
// 2) Verifies Turnstile token server-side.
// 3) Uploads each file to R2 binding (UPLOADS) with UUID-based keys.
// 4) Forwards metadata + R2 file URLs (same-origin /files/...) to Make webhook.
//
// Env bindings required:
//   TURNSTILE_SECRET (Secret, shared with /api/verify)
//   UPLOADS          (R2 bucket binding — bind to 'sentinel-uploads')
//
// Webhook URL is hardcoded (not a secret; Turnstile is the gate).

const MAKE_WEBHOOK_URL = 'https://hook.us2.make.com/hwclvxojkyoodm4usbc7v5x1mox4n3zb';
const FILE_FIELDS = ['supplierInvoices', 'productImages', 'brandAuthorization', 'otherDocs'];
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
  // Strip path separators + control chars + weird unicode. Keep extension.
  return (name || 'file')
    .replace(/[\\/\x00-\x1F\x7F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9._\-]/g, '_')
    .slice(0, 200) || 'file';
}
function newId() {
  // Simple crypto-random 16 hex (CF Workers has crypto.getRandomValues).
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

  // Collect text fields (sanitize)
  const textFields = {};
  const textKeys = ['formType','sessionId','submittedAt','fullName','email','phoneNumber','businessLegalEntityName','storeName','sellerId','marketplace','accountType','tierSelected','suspensionType','suspensionDate','appealDeadline','suspensionNoticeText','asinList','complaintDetails','rightsHolderName','rightsHolderContact','rightsHolderContacted','odr','lsr','cr','vtr','yearsSelling','annualRevenue','previousAppeal','lastAmazonResponse','mailingAddress','termsAck','disclaimerAck','arbitrationAck','intakeUserAgent','intakeDisclosureVersion','intakeTimestamp'];
  for (const k of textKeys) {
    const v = fd.get(k);
    if (v !== null) textFields[k] = sanitize(String(v), 10000);
  }

  // Minimum validation
  if (!textFields.fullName || textFields.fullName.length < 2) {
    return new Response(JSON.stringify({ error: 'invalid_full_name' }), { status: 400, headers: cors });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(textFields.email || '')) {
    return new Response(JSON.stringify({ error: 'invalid_email' }), { status: 400, headers: cors });
  }
  if (!textFields.sellerId) {
    return new Response(JSON.stringify({ error: 'invalid_seller_id' }), { status: 400, headers: cors });
  }
  if (textFields.termsAck !== 'true' || textFields.disclaimerAck !== 'true' || textFields.arbitrationAck !== 'true') {
    return new Response(JSON.stringify({ error: 'acknowledgments_required' }), { status: 400, headers: cors });
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
        // Allow based on extension if MIME is unusual
        const ext = (f.name || '').split('.').pop().toLowerCase();
        const extOk = ['pdf','jpg','jpeg','png','gif','webp','doc','docx','xls','xlsx','txt'].includes(ext);
        if (!extOk) {
          return new Response(JSON.stringify({ error: 'file_type_rejected', field, name: f.name, type: mime }), { status: 415, headers: cors });
        }
      }
      const safeName = sanitizeFilename(f.name);
      const key = 'amazon/' + submissionId + '/' + field + '/' + newId().slice(0, 8) + '_' + safeName;
      try {
        await env.UPLOADS.put(key, f.stream(), {
          httpMetadata: { contentType: mime },
          customMetadata: {
            submissionId: submissionId,
            field: field,
            originalName: f.name || 'file',
            sellerEmail: textFields.email || '',
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

  // Build forward payload
  const payload = Object.assign({}, textFields, {
    submissionId: submissionId,
    verifiedAt: new Date().toISOString(),
    clientIp: clientIp,
    turnstileHost: (vj && vj.hostname) || '',
    uploads: uploads,
    fileCount: FILE_FIELDS.reduce(function (n, f) { return n + uploads[f].length; }, 0)
  });

  // Forward to Make webhook
  let makeResp;
  try {
    makeResp = await fetch(MAKE_WEBHOOK_URL, {
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
