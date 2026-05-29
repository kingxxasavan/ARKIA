// ARIA — optional backend proxy for AI providers.
// Only needed if you host on a Node server (Render/Railway/etc.) and want your
// API keys kept server-side. On a static host (Firebase Hosting), this isn't
// used — the app falls back to keys entered in Settings.
//
// Env vars: ANTHROPIC_KEY, OPENAI_KEY, OLLAMA_KEY, OPENROUTER_KEY

const express = require('express');
const path    = require('path');
const app     = express();

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// The chat app lives at /app; the landing page is the homepage (/).
app.get('/app', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

// ── Provider registry ──────────────────────────────────────────────────────
const PROVIDERS = {
  anthropic:  { base: 'https://api.anthropic.com',  keyEnv: 'ANTHROPIC_KEY',  auth: 'anthropic' },
  openai:     { base: 'https://api.openai.com',     keyEnv: 'OPENAI_KEY',     auth: 'bearer'    },
  ollama:     { base: 'https://ollama.com',         keyEnv: 'OLLAMA_KEY',     auth: 'bearer'    },
  openrouter: { base: 'https://openrouter.ai/api',  keyEnv: 'OPENROUTER_KEY', auth: 'bearer'    },
};

// Which providers have keys configured (also used by the client to detect server mode)
app.get('/api/status', (_req, res) => {
  const status = {};
  for (const [id, cfg] of Object.entries(PROVIDERS))
    status[id] = !!(process.env[cfg.keyEnv] || '').trim();
  res.json(status);
});

// ── Helper: stream a fetch response back to the client safely ──────────────
async function pipeResponse(upstream, res, req) {
  res.on('error', () => {});
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

// ── Universal AI provider proxy  /api/:provider/v1/... ──────────────────────
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
    headers['HTTP-Referer'] = process.env.SITE_URL || 'https://arkia-zeta.vercel.app';
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
