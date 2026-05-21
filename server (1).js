// ARIA — backend proxy server
// Runs on Replit (or any Node 18+ host). API keys live in env vars, never in the browser.
// Set these in Replit Secrets (the padlock icon):
//   ANTHROPIC_KEY   — sk-ant-…
//   OPENAI_KEY      — sk-…
//   OLLAMA_KEY      — your ollama.com cloud key
//   OPENROUTER_KEY  — sk-or-…  (free at openrouter.ai/keys)

const express = require('express');
const path    = require('path');
const app     = express();

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Provider registry ──────────────────────────────────────────────────────
const PROVIDERS = {
  anthropic:  { base: 'https://api.anthropic.com',  keyEnv: 'ANTHROPIC_KEY',  auth: 'anthropic' },
  openai:     { base: 'https://api.openai.com',     keyEnv: 'OPENAI_KEY',     auth: 'bearer'    },
  ollama:     { base: 'https://ollama.com',         keyEnv: 'OLLAMA_KEY',     auth: 'bearer'    },
  openrouter: { base: 'https://openrouter.ai/api',  keyEnv: 'OPENROUTER_KEY', auth: 'bearer'    },
};

// Tell the frontend which providers have keys configured
app.get('/api/status', (_req, res) => {
  const status = {};
  for (const [id, cfg] of Object.entries(PROVIDERS)) {
    status[id] = !!(process.env[cfg.keyEnv] || '').trim();
  }
  res.json(status);
});

// ── Universal proxy ────────────────────────────────────────────────────────
// Routes: /api/:provider/v1/messages  →  https://api.anthropic.com/v1/messages  (etc.)
app.all('/api/:provider/*', async (req, res) => {
  const cfg = PROVIDERS[req.params.provider];
  if (!cfg) return res.status(400).json({ error: 'Unknown provider: ' + req.params.provider });

  const apiKey = (process.env[cfg.keyEnv] || '').trim();
  if (!apiKey) {
    return res.status(401).json({
      error: `${cfg.keyEnv} is not set. Go to Replit Secrets and add it.`
    });
  }

  // Build upstream URL:  /api/ollama/v1/chat/completions  →  https://ollama.com/v1/chat/completions
  const subpath = req.params[0];                    // e.g. "v1/chat/completions"
  const targetUrl = `${cfg.base}/${subpath}`;

  // Build headers
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.auth === 'anthropic') {
    headers['x-api-key']          = apiKey;
    headers['anthropic-version']  = '2023-06-01';
    // Forward beta flags the client requested (e.g. thinking, citations)
    if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  if (req.params.provider === 'openrouter') {
    headers['HTTP-Referer'] = process.env.SITE_URL || 'https://replit.com';
    headers['X-Title']      = 'ARIA';
  }

  try {
    const upstream = await fetch(targetUrl, {
      method:  req.method,
      headers,
      body:    req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
    });

    res.status(upstream.status);
    res.set('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.set('Cache-Control', 'no-cache');

    if (!upstream.body) { res.end(); return; }

    // Stream the response straight back to the browser
    const reader = upstream.body.getReader();
    req.on('close', () => reader.cancel().catch(() => {}));
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); break; }
      if (!res.write(value)) await new Promise(r => res.once('drain', r));
    }
  } catch (err) {
    console.error(`[${req.params.provider}]`, err.message);
    if (!res.headersSent) res.status(502).json({ error: err.message });
  }
});

// ── Built-in Browser Proxy ─────────────────────────────────────────────────
// Fetches any URL server-side, strips X-Frame-Options / CSP so the page can
// render inside an <iframe>, and injects link-intercept + content-extract scripts.
app.get('/browse', async (req, res) => {
  const raw = (req.query.url || '').trim();
  if (!raw) return res.status(400).send(errPage('No URL provided', 'Add ?url=https://example.com'));

  // Resolve relative/bare URLs
  let targetUrl = raw;
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });

    const finalUrl = upstream.url || targetUrl; // after redirects
    const ct = upstream.headers.get('content-type') || 'text/html';

    // Strip iframe-blocking headers
    res.removeHeader('x-frame-options');
    res.removeHeader('content-security-policy');
    res.set('Content-Type', ct);

    if (ct.includes('text/html')) {
      let html = await upstream.text();

      // Inject <base> so relative assets resolve, plus our intercept scripts
      const inject = `
<base href="${finalUrl}">
<script>
(function(){
  // Tell parent our current URL (for address bar sync)
  window.parent.postMessage({type:'browsed',url:'${finalUrl}',title:document.title},'*');
  // Re-send title once DOM is ready
  document.addEventListener('DOMContentLoaded',function(){
    window.parent.postMessage({type:'browsed',url:'${finalUrl}',title:document.title},'*');
  });
  // Intercept link clicks — route through our proxy
  document.addEventListener('click',function(e){
    var a=e.target.closest('a');
    if(a&&a.href&&!a.href.startsWith('javascript')&&!a.href.startsWith('mailto')&&!a.href.startsWith('#')){
      e.preventDefault();
      window.parent.postMessage({type:'navigate',url:a.href},'*');
    }
  },true);
  // Intercept form submits (GET forms → search works)
  document.addEventListener('submit',function(e){
    var f=e.target;
    if(f.method.toUpperCase()!=='POST'){
      e.preventDefault();
      var d=new URLSearchParams(new FormData(f)).toString();
      var url=f.action+(d?'?'+d:'');
      window.parent.postMessage({type:'navigate',url:url},'*');
    }
  },true);
  // Respond to "send page content to ARIA" requests
  window.addEventListener('message',function(e){
    if(e.data&&e.data.type==='getContent'){
      window.parent.postMessage({
        type:'pageContent',
        url:'${finalUrl}',
        title:document.title,
        text:(document.body?document.body.innerText:'').slice(0,8000)
      },'*');
    }
  });
})();
</script>`;

      // Insert just after <head> (or at top if no head tag)
      if (/<head[\s>]/i.test(html)) {
        html = html.replace(/<head([^>]*)>/i, '<head$1>' + inject);
      } else {
        html = inject + html;
      }
      res.send(html);
    } else {
      // Non-HTML: stream through (images, CSS, JS, etc.)
      upstream.body.pipeTo(new WritableStream({
        write(chunk){ res.write(chunk); },
        close(){ res.end(); }
      }));
    }
  } catch (err) {
    res.status(502).send(errPage('Could not load page', err.message));
  }
});

function errPage(title, msg){
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:80vh;margin:0;background:#1a1714;color:#f0e9df}
    .box{text-align:center;max-width:420px;padding:32px}h2{margin:0 0 10px;font-size:20px}p{color:#b3a99c;font-size:14px;margin:0}
  </style></head><body><div class="box"><h2>🌐 ${title}</h2><p>${msg}</p></div></body></html>`;
}

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ARIA running on http://localhost:${PORT}`);
  for (const [id, cfg] of Object.entries(PROVIDERS)) {
    const ok = !!(process.env[cfg.keyEnv] || '').trim();
    console.log(`  ${ok ? '✓' : '✗'} ${id.padEnd(12)} (${cfg.keyEnv})`);
  }
});
