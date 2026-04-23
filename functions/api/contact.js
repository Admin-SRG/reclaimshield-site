// functions/api/contact.js
// Cloudflare Pages Function — verifies Turnstile, then forwards contact-form
// payload to the CONTACT-WEB Make scenario (Sc 4835703), which emails admin.
// Reads from env: TURNSTILE_SECRET (already set for /api/verify).
// Webhook URL is hardcoded because it's not a secret; Turnstile is the gate.
// Deployed automatically on git push to main (CF Pages build).

const CONTACT_WEBHOOK_URL = 'https://hook.us2.make.com/o44rv403i1v5vswtpilhgidwp9y7lwrc';

function sanitizeField(s, maxLen) {
  if (typeof s !== 'string') return '';
  // Strip NUL + control chars except \n \r \t; collapse to trimmed, length-capped string.
  var cleaned = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  if (cleaned.length > maxLen) cleaned = cleaned.slice(0, maxLen);
  return cleaned;
}

function isValidEmail(s) {
  if (typeof s !== 'string' || s.length > 254) return false;
  // Conservative RFC-5322-lite check: one @, at least one char on each side, TLD of 2+ chars.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

async function onRequestPost({ request, env }) {
  const origin = new URL(request.url).origin;
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
    'Content-Type': 'application/json'
  };

  const SECRET = env.TURNSTILE_SECRET;
  if (!SECRET) {
    return new Response(JSON.stringify({ error: 'server_misconfigured' }), { status: 500, headers: corsHeaders });
  }

  let payload;
  try {
    payload = await request.json();
  } catch (_e) {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400, headers: corsHeaders });
  }

  const token = payload && payload.turnstileToken;
  if (!token || typeof token !== 'string' || token.length < 20) {
    return new Response(JSON.stringify({ error: 'missing_turnstile_token' }), { status: 400, headers: corsHeaders });
  }

  const name = sanitizeField(payload.name, 120);
  const email = sanitizeField(payload.email, 254);
  const message = sanitizeField(payload.message, 5000);
  const sourcePath = sanitizeField(payload.sourcePath, 200) || '/meta';

  if (!name || name.length < 2) {
    return new Response(JSON.stringify({ error: 'invalid_name' }), { status: 400, headers: corsHeaders });
  }
  if (!isValidEmail(email)) {
    return new Response(JSON.stringify({ error: 'invalid_email' }), { status: 400, headers: corsHeaders });
  }
  if (!message || message.length < 5) {
    return new Response(JSON.stringify({ error: 'invalid_message' }), { status: 400, headers: corsHeaders });
  }

  const clientIp = request.headers.get('CF-Connecting-IP') || '';
  const verifyBody = new FormData();
  verifyBody.append('secret', SECRET);
  verifyBody.append('response', token);
  if (clientIp) verifyBody.append('remoteip', clientIp);

  let verifyJson;
  try {
    const vResp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: verifyBody
    });
    verifyJson = await vResp.json();
  } catch (_e) {
    return new Response(JSON.stringify({ error: 'verify_network_error' }), { status: 502, headers: corsHeaders });
  }

  if (!verifyJson || verifyJson.success !== true) {
    return new Response(JSON.stringify({
      error: 'turnstile_failed',
      codes: verifyJson ? (verifyJson['error-codes'] || []) : []
    }), { status: 403, headers: corsHeaders });
  }

  const forwardPayload = {
    name: name,
    email: email,
    message: message,
    sourcePath: sourcePath,
    verifiedAt: new Date().toISOString(),
    clientIp: clientIp,
    turnstileHost: verifyJson.hostname || '',
    turnstileChallengeTs: verifyJson.challenge_ts || ''
  };

  let hookResp;
  try {
    hookResp = await fetch(CONTACT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(forwardPayload)
    });
  } catch (_e) {
    return new Response(JSON.stringify({ error: 'webhook_network_error' }), { status: 502, headers: corsHeaders });
  }

  // Make scenario responds with {"success": true} and status 200 on its own webhook-respond module.
  // We forward the outcome to the browser as a minimal JSON.
  return new Response(JSON.stringify({
    ok: hookResp.ok,
    status: hookResp.status
  }), { status: hookResp.ok ? 200 : 502, headers: corsHeaders });
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
