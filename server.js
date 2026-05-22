// ARIA — backend proxy + per-user data API
// Env vars (set in your host dashboard, e.g. Vercel → Settings → Environment Variables):
//   AI keys:   ANTHROPIC_KEY, OPENAI_KEY, OLLAMA_KEY, OPENROUTER_KEY
//   Auth0:     AUTH0_DOMAIN, AUTH0_CLIENT_ID
//   Database:  KV_REST_API_URL + KV_REST_API_TOKEN  (or UPSTASH_REDIS_REST_URL/TOKEN)

const express = require('express');
const path    = require('path');
const app     = express();

// ── Storage: Upstash Redis (Vercel Marketplace) ────────────────────────────
const REDIS_URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || '';
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
let redis = null;
if (REDIS_URL && REDIS_TOKEN) {
  try { const { Redis } = require('@upstash/redis'); redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN }); }
  catch (e) { console.error('Redis init failed:', e.message); }
}

// ── Auth: verify Auth0 ID tokens (RS256 via the tenant JWKS) ────────────────
const AUTH0_DOMAIN    = process.env.AUTH0_DOMAIN || '';
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID || '';
let _jose, _jwks;
async function getJose() { if (!_jose) _jose = await import('jose'); return _jose; }
async function userFromReq(req) {
  if (!AUTH0_DOMAIN || !AUTH0_CLIENT_ID) return null;
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/i);
  if (!m) return null;
  try {
    const { jwtVerify, createRemoteJWKSet } = await getJose();
    if (!_jwks) _jwks = createRemoteJWKSet(new URL(`https://${AUTH0_DOMAIN}/.well-known/jwks.json`));
    const { payload } = await jwtVerify(m[1], _jwks, {
      issuer: `https://${AUTH0_DOMAIN}/`,
      audience: AUTH0_CLIENT_ID,
    });
    return payload.sub || null;
  } catch (e) { return null; }
}
async function requireUser(req, res) {
  const sub = await userFromReq(req);
  if (!sub) { res.status(401).json({ error: 'unauthorized' }); return null; }
  return sub;
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

// Public client config — only exposes Auth0's public web values when set.
app.get('/api/config', (_req, res) => {
  res.json({ auth0: (AUTH0_DOMAIN && AUTH0_CLIENT_ID) ? { domain: AUTH0_DOMAIN, clientId: AUTH0_CLIENT_ID } : null });
});

// Which providers have keys configured
app.get('/api/status', (_req, res) => {
  const status = {};
  for (const [id, cfg] of Object.entries(PROVIDERS))
    status[id] = !!(process.env[cfg.keyEnv] || '').trim();
  res.json(status);
});

// ── Per-user data (Auth0-gated, stored in Redis) ────────────────────────────
app.get('/api/memory', async (req, res) => {
  const sub = await requireUser(req, res); if (!sub) return;
  if (!redis) return res.json({ facts: [] });
  const facts = await redis.get(`memory:${sub}`);
  res.json({ facts: Array.isArray(facts) ? facts : [] });
});
app.put('/api/memory', async (req, res) => {
  const sub = await requireUser(req, res); if (!sub) return;
  if (!redis) return res.status(503).json({ error: 'storage not configured' });
  const facts = cleanFacts(req.body);
  try { await redis.set(`memory:${sub}`, facts); res.json({ facts }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/chats', async (req, res) => {
  const sub = await requireUser(req, res); if (!sub) return;
  if (!redis) return res.json({ convs: [] });
  const convs = await redis.get(`chats:${sub}`);
  res.json({ convs: Array.isArray(convs) ? convs : [] });
});
app.put('/api/chats', async (req, res) => {
  const sub = await requireUser(req, res); if (!sub) return;
  if (!redis) return res.status(503).json({ error: 'storage not configured' });
  const convs = Array.isArray(req.body?.convs) ? req.body.convs : [];
  try { await redis.set(`chats:${sub}`, convs); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/profile', async (req, res) => {
  const sub = await requireUser(req, res); if (!sub) return;
  if (!redis) return res.json({ displayName: '' });
  const p = (await redis.get(`profile:${sub}`)) || {};
  res.json({ displayName: p.displayName || '' });
});
app.put('/api/profile', async (req, res) => {
  const sub = await requireUser(req, res); if (!sub) return;
  if (!redis) return res.status(503).json({ error: 'storage not configured' });
  const displayName = String(req.body?.displayName || '').trim().slice(0, 60);
  try { await redis.set(`profile:${sub}`, { displayName }); res.json({ displayName }); }
  catch (e) { res.status(500).json({ error: e.message }); }
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
    console.log(`  ${redis ? '✓' : '✗'} Redis storage`);
    console.log(`  ${(AUTH0_DOMAIN && AUTH0_CLIENT_ID) ? '✓' : '✗'} Auth0`);
    for (const [id, cfg] of Object.entries(PROVIDERS))
      console.log(`  ${(process.env[cfg.keyEnv]||'').trim() ? '✓' : '✗'} ${id.padEnd(12)} (${cfg.keyEnv})`);
  });
}

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err?.message || err));

module.exports = app;
