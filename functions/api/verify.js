// functions/api/verify.js
// Cloudflare Pages Function — pre-verifies Turnstile, then forwards to Make webhook.
// Reads from env vars: TURNSTILE_SECRET, MAKE_WEBHOOK_URL
// Deployed automatically on git push to main (CF Pages build).

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
  const WEBHOOK = env.MAKE_WEBHOOK_URL;
  if (!SECRET || !WEBHOOK) {
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

  const { turnstileToken: _drop, ...forwardPayload } = payload;
  forwardPayload.verifiedAt = new Date().toISOString();
  forwardPayload.clientIp = clientIp;
  forwardPayload.turnstileHost = verifyJson.hostname || '';
  forwardPayload.turnstileChallengeTs = verifyJson.challenge_ts || '';

  let makeResp;
  try {
    makeResp = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(forwardPayload)
    });
  } catch (_e) {
    return new Response(JSON.stringify({ error: 'webhook_network_error' }), { status: 502, headers: corsHeaders });
  }

  const makeBody = await makeResp.text();
  return new Response(JSON.stringify({
    ok: makeResp.ok,
    status: makeResp.status,
    body: makeBody
  }), { status: makeResp.ok ? 200 : 502, headers: corsHeaders });
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
