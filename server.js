// ARIA — backend proxy server
// Set API keys as environment variables (Vercel/host dashboard):
//   ANTHROPIC_KEY, OPENAI_KEY, OLLAMA_KEY, OPENROUTER_KEY

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const app     = express();

// Memory store — a JSON file fallback (per-user memory lives in Firebase).
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

// ── Long-term memory (file fallback; primary store is Firebase) ─────────────
app.get('/api/memory', (_req, res) => {
  res.json(readMemory());
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
  if (!apiKey) return res.status(401).json({ error: `${cfg.keyEnv} is not set in the server environment variables.` });

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
    headers['HTTP-Referer'] = process.env.SITE_URL || 'https://aria.app';
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

// Export the app for serverless (Vercel); listen directly when run normally.
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ARIA running on port ${PORT}`);
    for (const [id, cfg] of Object.entries(PROVIDERS))
      console.log(`  ${(process.env[cfg.keyEnv]||'').trim() ? '✓' : '✗'} ${id.padEnd(12)} (${cfg.keyEnv})`);
  });
}

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err?.message || err));

module.exports = app;
