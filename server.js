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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ── Image search (DuckDuckGo) ──────────────────────────────────────────────
app.get('/api/images', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  try {
    const seed = await fetch('https://duckduckgo.com/?q=' + encodeURIComponent(q) + '&iax=images&ia=images',
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    const html = await seed.text();
    const m = html.match(/vqd=["']?([-\d]+)["']?/);
    if (!m) return res.json({ results: [] });
    const api = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(q)}&vqd=${m[1]}&f=,,,&p=1`;
    const r = await fetch(api, { headers: { 'User-Agent': UA, 'Referer': 'https://duckduckgo.com/', 'Accept': 'application/json' }, signal: AbortSignal.timeout(12000) });
    const data = await r.json();
    const results = (data.results || []).slice(0, 60).map(x => ({
      image: x.image, thumbnail: x.thumbnail, title: x.title || '', source: x.url || '',
      width: x.width, height: x.height,
    }));
    res.json({ results });
  } catch (e) { res.json({ results: [], error: e.message }); }
});

// ── Video search (YouTube) ─────────────────────────────────────────────────
app.get('/api/videos', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  try {
    const r = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(q),
      { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(12000) });
    const html = await r.text();
    const seen = new Set(), results = [];
    const m = html.match(/ytInitialData\s*=\s*(\{.+?\});<\/script>/s);
    if (m) {
      try {
        (function walk(o) {
          if (!o || typeof o !== 'object' || results.length >= 40) return;
          if (o.videoRenderer && o.videoRenderer.videoId) {
            const v = o.videoRenderer, id = v.videoId;
            if (!seen.has(id)) {
              seen.add(id);
              results.push({
                id,
                title: (v.title && (v.title.runs?.[0]?.text || v.title.simpleText)) || '',
                channel: (v.ownerText && v.ownerText.runs?.[0]?.text) || '',
                length: (v.lengthText && v.lengthText.simpleText) || '',
                thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
              });
            }
          }
          for (const k in o) walk(o[k]);
        })(JSON.parse(m[1]));
      } catch {}
    }
    if (!results.length) {
      const re = /"videoId":"([\w-]{11})"/g; let mm;
      while ((mm = re.exec(html)) && results.length < 30) {
        if (!seen.has(mm[1])) { seen.add(mm[1]); results.push({ id: mm[1], title: '', channel: '', length: '', thumbnail: `https://i.ytimg.com/vi/${mm[1]}/hqdefault.jpg` }); }
      }
    }
    res.json({ results: results.slice(0, 40) });
  } catch (e) { res.json({ results: [], error: e.message }); }
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

// ── Built-in browser proxy ─────────────────────────────────────────────────
// Path form  /browse/https://site/page  (preferred — relative URLs resolve
// against the proxied path) and legacy query form  /browse?url=...
const RES_SKIP = /^(data:|blob:|javascript:|mailto:|tel:|about:|#|vbscript:)/i;

function browseTarget(req) {
  if (req.query && req.query.url) return String(req.query.url).trim();
  const m = req.originalUrl.match(/^\/browse\/(.+)$/);
  return m ? m[1].trim() : '';
}
function P(ref, base) {
  ref = String(ref == null ? '' : ref).trim();
  if (!ref || RES_SKIP.test(ref)) return ref;
  try { return '/browse/' + new URL(ref, base).href; } catch { return ref; }
}
function rewriteSrcset(val, base) {
  return val.split(',').map(part => {
    const s = part.trim(); if (!s) return '';
    const i = s.search(/\s/);
    return i < 0 ? P(s, base) : P(s.slice(0, i), base) + s.slice(i);
  }).filter(Boolean).join(', ');
}
function rewriteCss(css, base) {
  return String(css)
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => RES_SKIP.test(u.trim()) ? m : `url(${q}${P(u, base)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => `@import ${q}${P(u, base)}${q}`);
}
function rewriteHtml(html, base) {
  html = String(html)
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/\sintegrity\s*=\s*(["'])[^"']*\1/gi, '')
    .replace(/\s(src|href|poster|action|data-src)\s*=\s*"([^"]*)"/gi, (m, a, v) => ` ${a}="${P(v, base)}"`)
    .replace(/\s(src|href|poster|action|data-src)\s*=\s*'([^']*)'/gi, (m, a, v) => ` ${a}='${P(v, base)}'`)
    .replace(/\ssrcset\s*=\s*"([^"]*)"/gi, (m, v) => ` srcset="${rewriteSrcset(v, base)}"`)
    .replace(/\ssrcset\s*=\s*'([^']*)'/gi, (m, v) => ` srcset='${rewriteSrcset(v, base)}'`)
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => RES_SKIP.test(u.trim()) ? m : `url(${q}${P(u, base)}${q})`);
  const inject = helperScript(base);
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
  if (/<html[\s>]/i.test(html)) return html.replace(/<html([^>]*)>/i, `<html$1>${inject}`);
  return inject + html;
}
function helperScript(pageUrl) {
  const safe = pageUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `<script>(function(){
  function real(u){var i=u.indexOf('/browse/');return i>=0?u.slice(i+8):u;}
  function ping(){try{parent.postMessage({type:'browsed',url:'${safe}',title:document.title},'*');}catch(e){}}
  ping(); document.addEventListener('DOMContentLoaded',ping);
  document.addEventListener('click',function(e){
    var a=e.target.closest&&e.target.closest('a'); if(!a||!a.href) return;
    var raw=a.getAttribute('href')||''; if(/^(javascript:|mailto:|tel:|#)/i.test(raw)) return;
    e.preventDefault(); parent.postMessage({type:'navigate',url:real(a.href)},'*');
  },true);
  document.addEventListener('submit',function(e){
    var f=e.target; if(((f.method||'get')+'').toLowerCase()==='post') return;
    e.preventDefault();
    var act=real(f.action||'${safe}'), qs=new URLSearchParams(new FormData(f)).toString();
    parent.postMessage({type:'navigate',url:act+(act.indexOf('?')>=0?'&':'?')+qs},'*');
  },true);
  window.addEventListener('message',function(e){
    if(e.data&&e.data.type==='getContent'){
      parent.postMessage({type:'pageContent',url:'${safe}',title:document.title,text:(document.body?document.body.innerText:'').slice(0,8000)},'*');
    }
  });
})();</script>`;
}

app.get(/^\/browse(?:\/.*)?$/, async (req, res) => {
  let url = browseTarget(req);
  if (!url) return res.status(400).send(errPage('No URL', 'Add a web address to browse.'));
  if (/^\/\//.test(url)) url = 'https:' + url;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  res.on('error', () => {});
  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });

    const finalUrl = upstream.url || url;
    const ct = upstream.headers.get('content-type') || 'text/html';

    res.removeHeader('x-frame-options');
    res.removeHeader('content-security-policy');
    res.set('Cache-Control', 'no-cache');
    res.set('Content-Type', ct);

    if (ct.includes('text/html')) {
      res.send(rewriteHtml(await upstream.text(), finalUrl));
    } else if (ct.includes('text/css')) {
      res.send(rewriteCss(await upstream.text(), finalUrl));
    } else {
      await pipeResponse(upstream, res, req);
    }
  } catch (err) {
    if (!res.headersSent) res.status(502).send(errPage('Could not load page', err.message));
  }
});

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
