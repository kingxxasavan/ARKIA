// ARIA — backend proxy server
// Set API keys in Replit Secrets (padlock icon):
//   ANTHROPIC_KEY, OPENAI_KEY, OLLAMA_KEY, OPENROUTER_KEY

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const app     = express();

// Memory store — a JSON file that auto-creates and persists the user's facts.
const MEMORY_FILE = process.env.MEMORY_FILE || path.join(__dirname, 'data', 'memory.json');

function readMemory() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); }
  catch { return { version: 1, facts: [], updated: null }; }
}
function writeMemory(facts) {
  const data = { version: 1, facts, updated: new Date().toISOString() };
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
  return data;
}
function cleanFacts(input) {
  const arr = Array.isArray(input) ? input : Array.isArray(input?.facts) ? input.facts : [];
  const seen = new Set(), out = [];
  for (const f of arr) {
    if (typeof f !== 'string' || !f.trim()) continue;
    const t = f.trim(), k = t.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  return out;
}

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Provider registry ──────────────────────────────────────────────────────
const PROVIDERS = {
  anthropic:  { base: 'https://api.anthropic.com',  keyEnv: 'ANTHROPIC_KEY',  auth: 'anthropic' },
  openai:     { base: 'https://api.openai.com',     keyEnv: 'OPENAI_KEY',     auth: 'bearer'    },
  ollama:     { base: 'https://ollama.com',         keyEnv: 'OLLAMA_KEY',     auth: 'bearer'    },
  openrouter: { base: 'https://openrouter.ai/api',  keyEnv: 'OPENROUTER_KEY', auth: 'bearer'    },
};

// Which providers have keys configured
app.get('/api/status', (_req, res) => {
  const status = {};
  for (const [id, cfg] of Object.entries(PROVIDERS))
    status[id] = !!(process.env[cfg.keyEnv] || '').trim();
  res.json(status);
});

// ── Long-term memory  (auto-creates data/memory.json) ──────────────────────
app.get('/api/memory', (_req, res) => {
  const data = readMemory();
  if (!fs.existsSync(MEMORY_FILE)) { try { writeMemory(data.facts); } catch {} }
  res.json(data);
});

app.put('/api/memory', (req, res) => {
  try { res.json(writeMemory(cleanFacts(req.body))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Helper: stream a fetch response back to the client safely ──────────────
async function pipeResponse(upstream, res, req) {
  res.on('error', () => {});          // prevent unhandled error events on res
  if (!upstream.body) { res.end(); return; }
  const reader = upstream.body.getReader();
  req.on('close', () => reader.cancel().catch(() => {}));
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); break; }
      if (!res.write(value)) await new Promise(r => res.once('drain', r));
    }
  } catch (err) {
    if (!res.writableEnded) res.end();
  }
}

// ── Universal API proxy  /api/:provider/v1/... ─────────────────────────────
app.all('/api/:provider/*', async (req, res) => {
  const cfg = PROVIDERS[req.params.provider];
  if (!cfg) return res.status(400).json({ error: 'Unknown provider: ' + req.params.provider });

  const apiKey = (process.env[cfg.keyEnv] || '').trim();
  if (!apiKey) return res.status(401).json({ error: `${cfg.keyEnv} is not set in Replit Secrets.` });

  const targetUrl = `${cfg.base}/${req.params[0]}`;
  const headers   = { 'Content-Type': 'application/json' };

  if (cfg.auth === 'anthropic') {
    headers['x-api-key']         = apiKey;
    headers['anthropic-version'] = '2023-06-01';
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
      signal:  AbortSignal.timeout(120000),
    });
    res.status(upstream.status);
    res.set('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.set('Cache-Control', 'no-cache');
    await pipeResponse(upstream, res, req);
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: err.message });
  }
});

// ── Built-in browser proxy  /browse?url=... ────────────────────────────────
app.get('/browse', async (req, res) => {
  let url = (req.query.url || '').trim();
  if (!url) return res.status(400).send(errPage('No URL', 'Add ?url=https://example.com'));
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  res.on('error', () => {});

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });

    const finalUrl = upstream.url || url;
    const ct       = upstream.headers.get('content-type') || 'text/html';

    // Strip headers that block iframing
    res.removeHeader('x-frame-options');
    res.removeHeader('content-security-policy');
    res.set('Content-Type', ct);

    if (ct.includes('text/html')) {
      const html = await upstream.text();
      res.send(injectHelpers(html, finalUrl));
    } else {
      // Images, CSS, JS etc — stream through
      await pipeResponse(upstream, res, req);
    }
  } catch (err) {
    if (!res.headersSent) res.status(502).send(errPage('Could not load page', err.message));
  }
});

function injectHelpers(html, finalUrl) {
  const safe = finalUrl.replace(/'/g, "\\'");
  const inject = `<base href="${finalUrl}">
<script>
(function(){
  window.parent.postMessage({type:'browsed',url:'${safe}',title:document.title},'*');
  document.addEventListener('DOMContentLoaded',function(){
    window.parent.postMessage({type:'browsed',url:'${safe}',title:document.title},'*');
  });
  document.addEventListener('click',function(e){
    var a=e.target.closest('a');
    if(a&&a.href&&!/^(javascript|mailto|#)/i.test(a.href)){
      e.preventDefault();
      window.parent.postMessage({type:'navigate',url:a.href},'*');
    }
  },true);
  document.addEventListener('submit',function(e){
    var f=e.target;
    if(f.method.toUpperCase()!=='POST'){
      e.preventDefault();
      var url=f.action+'?'+new URLSearchParams(new FormData(f));
      window.parent.postMessage({type:'navigate',url:url},'*');
    }
  },true);
  window.addEventListener('message',function(e){
    if(e.data&&e.data.type==='getContent'){
      window.parent.postMessage({
        type:'pageContent',url:'${safe}',title:document.title,
        text:(document.body?document.body.innerText:'').slice(0,8000)
      },'*');
    }
  });
})();
</script>`;

  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, '<head$1>' + inject);
  return inject + html;
}

function errPage(title, msg) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;
         height:80vh;margin:0;background:#1a1714;color:#f0e9df}
    .box{text-align:center;max-width:420px;padding:32px}
    h2{margin:0 0 10px}p{color:#b3a99c;font-size:14px;margin:0}
  </style></head><body><div class="box"><h2>🌐 ${title}</h2><p>${msg}</p></div></body></html>`;
}

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ARIA running on port ${PORT}`);
  for (const [id, cfg] of Object.entries(PROVIDERS))
    console.log(`  ${(process.env[cfg.keyEnv]||'').trim() ? '✓' : '✗'} ${id.padEnd(12)} (${cfg.keyEnv})`);
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err?.message || err));
