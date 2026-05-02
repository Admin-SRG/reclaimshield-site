/* Shield Support — embeddable floating chat widget for ReclaimShield
 * Include on any page:
 *   <script src="/assets/shield-support-widget.js" data-product="Meta"></script>
 * data-product attribute is optional (Meta | Amazon) — surfaces page context to the agent.
 */
(function () {
  'use strict';
  if (window.__shieldSupportLoaded) return;
  window.__shieldSupportLoaded = true;

  var scriptTag = document.currentScript || document.querySelector('script[src*="shield-support-widget"]');
  var productContext = (scriptTag && scriptTag.getAttribute('data-product')) || '';

  // Session management (persists across reloads)
  function uuid() {
    var s = (crypto && crypto.randomUUID) ? crypto.randomUUID() : '';
    if (s) return s;
    // fallback
    return 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  var sessionId = '';
  try {
    sessionId = localStorage.getItem('shield_support_session') || '';
  } catch (_) {}
  if (!sessionId) {
    sessionId = uuid();
    try { localStorage.setItem('shield_support_session', sessionId); } catch (_) {}
  }

  // --- Styles ---
  var style = document.createElement('style');
  style.textContent = [
    '#ss-bubble{position:fixed;bottom:22px;right:22px;width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#7C3AED 0%,#2DD4BF 100%);box-shadow:0 4px 14px rgba(10,10,15,0.38);cursor:pointer;z-index:2147483640;display:flex;align-items:center;justify-content:center;transition:transform .15s ease;border:none}',
    '#ss-bubble:hover{transform:scale(1.05)}',
    '#ss-bubble svg{width:28px;height:28px;fill:#fff}',
    '#ss-badge{position:absolute;top:-4px;right:-4px;background:#2DD4BF;color:#0A0A0F;font-size:10px;font-weight:700;padding:2px 6px;border-radius:10px;font-family:-apple-system,Inter,Arial,sans-serif}',
    '#ss-panel{position:fixed;bottom:90px;right:22px;width:380px;max-width:calc(100vw - 44px);height:560px;max-height:calc(100vh - 120px);background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(10,10,15,0.28);z-index:2147483641;display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,Inter,Segoe UI,Arial,sans-serif}',
    '#ss-panel.ss-open{display:flex}',
    '#ss-header{background:#0A0A0F;background-image:linear-gradient(135deg,#7C3AED 0%,#2DD4BF 100%);color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between}',
    '#ss-header-text{display:flex;flex-direction:column;gap:2px}',
    '#ss-title{font-family:Cormorant Garamond,Georgia,serif;font-size:18px;font-weight:600;letter-spacing:.3px;line-height:1}',
    '#ss-sub{font-size:11px;opacity:.9;letter-spacing:1px;text-transform:uppercase;font-weight:500}',
    '#ss-close{background:transparent;border:none;color:#fff;cursor:pointer;padding:4px;border-radius:4px;opacity:.85}',
    '#ss-close:hover{opacity:1;background:rgba(255,255,255,.1)}',
    '#ss-close svg{width:18px;height:18px;fill:#fff;display:block}',
    '#ss-messages{flex:1;overflow-y:auto;padding:16px;background:#F9FAFB;display:flex;flex-direction:column;gap:10px}',
    '.ss-msg{max-width:82%;padding:10px 13px;border-radius:14px;font-size:14.5px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}',
    '.ss-msg-user{align-self:flex-end;background:#7C3AED;color:#fff;border-bottom-right-radius:4px}',
    '.ss-msg-bot{align-self:flex-start;background:#fff;color:#111827;border:1px solid #E5E7EB;border-bottom-left-radius:4px}',
    '.ss-msg-bot a{color:#7C3AED;text-decoration:underline}',
    '.ss-typing{align-self:flex-start;color:#6B7280;font-size:12.5px;font-style:italic;padding:4px 8px}',
    '.ss-error{align-self:center;color:#B91C1C;font-size:12.5px;background:#FEE2E2;padding:6px 12px;border-radius:8px}',
    '#ss-composer{border-top:1px solid #E5E7EB;padding:10px;display:flex;gap:8px;background:#fff}',
    '#ss-input{flex:1;resize:none;border:1px solid #D1D5DB;border-radius:10px;padding:10px 12px;font-size:14.5px;font-family:inherit;outline:none;min-height:40px;max-height:120px;line-height:1.4}',
    '#ss-input:focus{border-color:#7C3AED;box-shadow:0 0 0 3px rgba(124,58,237,.18)}',
    '#ss-send{background:#0A0A0F;color:#fff;border:none;border-radius:10px;padding:0 16px;cursor:pointer;font-weight:600;font-size:14px}',
    '#ss-send:hover{background:#7C3AED}',
    '#ss-send:disabled{background:#9CA3AF;cursor:not-allowed}',
    '#ss-footer{padding:8px 14px;font-size:10.5px;color:#6B7280;background:#fff;border-top:1px solid #E5E7EB;text-align:center;letter-spacing:.2px}',
    '#ss-footer a{color:#7C3AED;text-decoration:none}',
    '@media (max-width:500px){#ss-panel{width:calc(100vw - 20px);right:10px;bottom:80px;height:calc(100vh - 100px)}#ss-bubble{bottom:14px;right:14px}}'
  ].join('\n');
  document.head.appendChild(style);

  // --- DOM ---
  var bubble = document.createElement('button');
  bubble.id = 'ss-bubble';
  bubble.setAttribute('aria-label', 'Open Shield Support chat');
  bubble.innerHTML = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 11h-2v-2h2v2zm0-4h-2V5h2v4z"/></svg>';

  var panel = document.createElement('div');
  panel.id = 'ss-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Shield Support');
  panel.innerHTML = [
    '<div id="ss-header">',
    '  <div id="ss-header-text">',
    '    <div id="ss-title">Shield Support</div>',
    '    <div id="ss-sub">ReclaimShield\u2122 AI assistant</div>',
    '  </div>',
    '  <button id="ss-close" aria-label="Close chat"><svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>',
    '</div>',
    '<div id="ss-messages" aria-live="polite"></div>',
    '<div id="ss-composer">',
    '  <textarea id="ss-input" placeholder="Ask about filing, the process, or anything else..." rows="1"></textarea>',
    '  <button id="ss-send" type="button">Send</button>',
    '</div>',
    '<div id="ss-footer">AI-assisted support. Not legal advice. <a href="/terms">Terms</a></div>'
  ].join('');

  document.body.appendChild(bubble);
  document.body.appendChild(panel);

  var msgsEl = panel.querySelector('#ss-messages');
  var inputEl = panel.querySelector('#ss-input');
  var sendEl = panel.querySelector('#ss-send');
  var closeEl = panel.querySelector('#ss-close');

  var history = [];
  try {
    var stored = localStorage.getItem('shield_support_history');
    if (stored) history = JSON.parse(stored).slice(-12);
  } catch (_) {}

  function saveHistory() {
    try { localStorage.setItem('shield_support_history', JSON.stringify(history.slice(-12))); } catch (_) {}
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderMessage(role, text) {
    var el = document.createElement('div');
    el.className = 'ss-msg ' + (role === 'user' ? 'ss-msg-user' : 'ss-msg-bot');
    // For bot messages, allow simple markdown-style links: [label](url)
    var html = escapeHtml(text);
    if (role !== 'user') {
      html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, label, url) {
        return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(label) + '</a>';
      });
    }
    el.innerHTML = html;
    msgsEl.appendChild(el);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function renderTyping() {
    var el = document.createElement('div');
    el.className = 'ss-typing';
    el.id = 'ss-typing';
    el.textContent = 'Shield Support is typing…';
    msgsEl.appendChild(el);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function clearTyping() {
    var t = msgsEl.querySelector('#ss-typing');
    if (t) t.remove();
  }

  function renderError(text) {
    var el = document.createElement('div');
    el.className = 'ss-error';
    el.textContent = text;
    msgsEl.appendChild(el);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  // Restore prior history on open
  function restoreHistoryIntoUI() {
    msgsEl.innerHTML = '';
    if (history.length === 0) {
      renderMessage('bot', 'Hi — I\'m Shield Support. I can help you navigate Meta or Amazon filings, answer questions about your packet, or pass something to the ReclaimShield team. What do you need?');
      return;
    }
    for (var i = 0; i < history.length; i++) {
      renderMessage(history[i].role, history[i].content);
    }
  }

  function openPanel() {
    panel.classList.add('ss-open');
    restoreHistoryIntoUI();
    setTimeout(function () { inputEl.focus(); }, 50);
  }

  function closePanel() {
    panel.classList.remove('ss-open');
  }

  bubble.addEventListener('click', openPanel);
  closeEl.addEventListener('click', closePanel);

  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });
  inputEl.addEventListener('input', function () {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  });
  sendEl.addEventListener('click', doSend);

  function doSend() {
    var text = (inputEl.value || '').trim();
    if (!text || sendEl.disabled) return;

    inputEl.value = '';
    inputEl.style.height = 'auto';
    sendEl.disabled = true;

    history.push({ role: 'user', content: text });
    saveHistory();
    renderMessage('user', text);
    renderTyping();

    var payload = {
      session_id: sessionId,
      message: text,
      history: history.slice(0, -1),
      product_context: productContext
    };

    fetch('/api/support-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || !j.ok) {
          throw new Error(j && j.error ? j.error : 'request_failed');
        }
        return j;
      });
    }).then(function (j) {
      clearTyping();
      var answer = j.answer || '(no response)';
      history.push({ role: 'assistant', content: answer });
      saveHistory();
      renderMessage('bot', answer);
    }).catch(function (err) {
      clearTyping();
      renderError('Sorry — I hit a snag. Try again in a moment, or use the contact form at reclaimshield.io/contact.');
      console.warn('shield-support error:', err);
    }).finally(function () {
      sendEl.disabled = false;
    });
  }

  // Expose minimal API for programmatic open
  window.ShieldSupport = {
    open: openPanel,
    close: closePanel,
    sessionId: sessionId
  };
})();
