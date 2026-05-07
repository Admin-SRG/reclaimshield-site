// functions/api/intake-followup-submit.js
// Receives the customer's follow-up reply from /intake-followup, runs PII scanner,
// verifies Turnstile, and forwards to Make webhook AS-2.5b for token-validated update.

const FOLLOWUP_WEBHOOK_URL = 'https://hook.us2.make.com/ims2ffsqzc7t6w0j24tyxqc59yym75q1';

const PII_PATTERNS = [
  { name: 'Social Security Number',
    re: /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/,
    hint: 'looks like a Social Security number' },
  { name: 'Credit Card Number',
    re: /\b(?:\d[ -]*?){13,19}\b/,
    hint: 'looks like a credit card number' },
  { name: 'Professional License Number',
    re: /\b(?:license|lic\.?|dre|npi|state\s*bar|bar\s*number|registration|reg\.?\s*#|cert\.?\s*#|md\s*license|rn\s*license|cna)\s*[:#]?\s*[A-Z]{0,3}-?\d{5,15}\b/i,
    hint: 'looks like a professional license/credential number' },
  { name: 'Employer Identification Number (EIN)',
    re: /\b\d{2}-\d{7}\b/,
    hint: 'looks like an EIN' },
  { name: 'Generic identifier',
    re: /\b(?:my\s+)?(?:id|identifier|number|account\s*#)\s*[:#=]?\s*\d{8,15}\b/i,
    hint: 'looks like an identifier' }
];

function detectPII(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  for (const p of PII_PATTERNS) {
    if (p.re.test(value)) return p;
  }
  return null;
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

  let body;
  try { body = await request.json(); }
  catch (_e) { return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400, headers: cors }); }

  const recordId = String(body.recordId || '').trim();
  const token = String(body.token || '').trim();
  const customerReply = String(body.customerReply || '').trim();
  const turnstileToken = String(body.turnstileToken || '').trim();

  if (!recordId || !/^rec[A-Za-z0-9]{14}$/.test(recordId)) {
    return new Response(JSON.stringify({ error: 'invalid_record_id' }), { status: 400, headers: cors });
  }
  if (!token || token.length < 16) {
    return new Response(JSON.stringify({ error: 'invalid_token', message: 'This follow-up link is invalid. Please use the link from your email.' }), { status: 400, headers: cors });
  }
  if (!customerReply || customerReply.length < 20) {
    return new Response(JSON.stringify({ error: 'reply_too_short', message: 'Please write at least one or two complete sentences answering the questions.' }), { status: 400, headers: cors });
  }
  if (customerReply.length > 20000) {
    return new Response(JSON.stringify({ error: 'reply_too_long' }), { status: 413, headers: cors });
  }

  // Verify Turnstile
  if (env.TURNSTILE_SECRET) {
    if (!turnstileToken || turnstileToken.length < 20) {
      return new Response(JSON.stringify({ error: 'missing_turnstile_token' }), { status: 400, headers: cors });
    }
    const clientIp = request.headers.get('CF-Connecting-IP') || '';
    const vb = new FormData();
    vb.append('secret', env.TURNSTILE_SECRET);
    vb.append('response', turnstileToken);
    if (clientIp) vb.append('remoteip', clientIp);
    let vj;
    try {
      const vr = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: vb });
      vj = await vr.json();
    } catch (_e) {
      return new Response(JSON.stringify({ error: 'verify_network_error' }), { status: 502, headers: cors });
    }
    if (!vj || vj.success !== true) {
      return new Response(JSON.stringify({ error: 'turnstile_failed' }), { status: 403, headers: cors });
    }
  }

  // PII scan — same locked rule
  const piiHit = detectPII(customerReply);
  if (piiHit) {
    return new Response(JSON.stringify({
      error: 'pii_detected',
      detected: piiHit.name,
      message: `Your reply contains what ${piiHit.hint}. ReclaimShield does not store identification numbers. Please remove it — when we draft your appeal, it will have a bracketed placeholder you fill in yourself before sending to Meta.`
    }), { status: 400, headers: cors });
  }

  // Forward to Make webhook (AS-2.5b token-validates against Airtable)
  const clientIp = request.headers.get('CF-Connecting-IP') || '';
  const payload = {
    recordId,
    token,
    customerReply,
    submittedAt: body.submittedAt || new Date().toISOString(),
    clientIp
  };

  let makeResp;
  try {
    makeResp = await fetch(FOLLOWUP_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (_e) {
    return new Response(JSON.stringify({ error: 'webhook_network_error' }), { status: 502, headers: cors });
  }

  return new Response(JSON.stringify({
    ok: makeResp.ok,
    status: makeResp.status
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

export { onRequestPost, onRequestOptions };
