// functions/_middleware.js
// Injects cookie consent banner script into all HTML responses
// GDPR (EU) + CCPA (California) compliant minimum.

const COOKIE_BANNER_SCRIPT = `
<script>
(function(){
  if (localStorage.getItem('srg-cookie-consent')) return;
  // Skip on /admin paths (internal only)
  if (location.pathname.startsWith('/admin')) return;
  var banner = document.createElement('div');
  banner.id = 'srg-cookie-banner';
  banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#0C1B2E;color:#fff;padding:18px 24px;font-family:-apple-system,Inter,Arial,sans-serif;font-size:14px;line-height:1.5;z-index:9999;box-shadow:0 -4px 24px rgba(0,0,0,0.18);display:flex;align-items:center;gap:18px;flex-wrap:wrap';
  banner.innerHTML =
    '<div style="flex:1;min-width:280px"><strong style="font-family:\\'Cormorant Garamond\\',Georgia,serif;font-size:1rem">We use minimal cookies.</strong> ' +
    'This site uses essential cookies to deliver service. We do not run advertising trackers. EU/EEA visitors have rights under GDPR; California residents have rights under CCPA. ' +
    'See our <a href="/privacy" style="color:#A7F3D0;text-decoration:underline">Privacy Policy</a> and <a href="/terms" style="color:#A7F3D0;text-decoration:underline">Terms</a>.</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button onclick="(function(){localStorage.setItem(\\'srg-cookie-consent\\',\\'accepted-\\'+new Date().toISOString());document.getElementById(\\'srg-cookie-banner\\').remove();})()" style="background:#2E7A69;color:#fff;border:0;padding:9px 18px;border-radius:5px;font-weight:700;cursor:pointer;font-family:inherit;font-size:13px">Accept</button>' +
      '<button onclick="(function(){localStorage.setItem(\\'srg-cookie-consent\\',\\'declined-\\'+new Date().toISOString());document.getElementById(\\'srg-cookie-banner\\').remove();})()" style="background:transparent;color:#fff;border:1px solid rgba(255,255,255,0.3);padding:9px 18px;border-radius:5px;font-weight:600;cursor:pointer;font-family:inherit;font-size:13px">Essential only</button>' +
    '</div>';
  document.body.appendChild(banner);
})();
</script>
`;

export async function onRequest(context) {
  const response = await context.next();
  // Only inject into HTML responses
  const ct = response.headers.get('content-type') || '';
  if (!ct.includes('text/html')) return response;
  // Skip if already injected (shouldn't happen but defensive)
  const body = await response.text();
  if (body.includes('srg-cookie-banner')) {
    return new Response(body, { status: response.status, headers: response.headers });
  }
  // Inject before </body>
  const newBody = body.replace('</body>', COOKIE_BANNER_SCRIPT + '</body>');
  const newResp = new Response(newBody, { status: response.status, headers: response.headers });
  // Update content-length if present
  newResp.headers.delete('content-length');
  return newResp;
}
