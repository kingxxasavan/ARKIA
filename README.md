# ARIA — Personal AI Assistant

A clean AI chat app running on **GLM-4.6 via Ollama Cloud**, with **accounts** (Firebase) and **per-user memory + chat history** that follow you across devices.

- **Accounts** — email/password + Google sign-in (Firebase Auth)
- **Memory** — ARIA keeps a single profile of what it learns about you (auto-learned as you chat, plus anything you add), saved to your account
- **Chat history** — conversations sync to your account (Firestore)
- **Built-in tools** — Calendar, Reminders, and Memory, always available to ARIA (no setup or toggles)
- **Documents** — attach text, code, or PDF files and ARIA reads them (it's a text model, so images aren't analysed)
- **Web search**, **dark mode**, and a tunable system prompt

The Firebase config is embedded in the client (this is normal — Firebase web keys are public). Security comes from Firebase Auth + the Firestore rules below.

---

## 1. Firebase setup (one-time, required for accounts)

In the [Firebase console](https://console.firebase.google.com) for project **arikia**:

1. **Authentication → Get started → Sign-in method** → enable **Email/Password** and **Google**.
2. **Firestore Database → Create database** (production mode), then **Rules** tab → paste and **Publish**:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /memories/{uid} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
       match /chats/{uid} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
       // Admin accounts — can curate the directory AND edit site-wide config.
       function isHubAdmin() {
         return request.auth != null
           && request.auth.token.email in [
                'kingasd8970@gmail.com',
                'fanegf837@gmail.com',
                'kingfan837@gmail.com'
              ];
       }
       // Curated homepage directory: anyone reads, only admins write.
       match /hub/{docId} {
         allow read: if true;
         allow write: if isHubAdmin();
       }
       // Site-wide config (active model, announcement, brand, theme): anyone reads, only admins write.
       match /config/{docId} {
         allow read: if true;
         allow write: if isHubAdmin();
       }
     }
   }
   ```
3. **Authentication → Settings → Authorized domains** → add every domain you serve from, e.g.
   `arikia.web.app`, `arikia.firebaseapp.com`, your `*.vercel.app` domain, and any custom domain.
   *(Login is blocked on domains not listed here.)*

---

## 2. Deploy

### Option A — Vercel
1. Import this repo in Vercel (it auto-detects `vercel.json`). The backend in `server.js`
   runs as a serverless function via `api/index.js`; `vercel.json` routes every `/api/*`
   request to it, while the HTML is served statically.
2. **Settings → Environment Variables**, then redeploy:

   | Variable | Purpose / where to get it |
   |----------|---------------------------|
   | `OLLAMA_KEY` | Ollama Cloud key (ollama.com/settings/keys) — enables proxied chat, web search, and AI import for everyone, no per-user key needed |
   | `LOCK_SYSTEM_PROMPT` + `LOCKED_SYSTEM_PROMPT` | *(optional)* always-reliable server-enforced locked prompt |
   | `FIREBASE_PROJECT` + `FIREBASE_API_KEY` | *(optional)* let the server read the **admin panel's** locked prompt from Firestore — requires an **unrestricted** API key (see below) |

3. Deploy, then add the Vercel domain to Firebase **Authorized domains** (step 1.3).

With `OLLAMA_KEY` set, the function proxies GLM-4.6 calls server-side (no key in the browser),
which is also what powers `/api/search` and the AI bookmark import.

> **Note on the serverless API key.** Firebase's default web API key is HTTP-referrer-restricted,
> so a server can't read Firestore with it. For panel-controlled prompt enforcement, create a
> dedicated key in Google Cloud Console → APIs & Services → Credentials: **Create credentials →
> API key**, then edit it → **Application restrictions: None**, **API restrictions: Cloud Firestore API**.
> Put that key in `FIREBASE_API_KEY`. (Or skip Firestore and use the `LOCK_SYSTEM_PROMPT` env vars.)

> **Streaming limit.** Vercel serverless functions cap at 60s (`maxDuration` in `vercel.json`).
> Very long single generations can be cut off; for unlimited streaming use a always-on Node host
> (Replit/Render) running `server.js` directly.

### Option B — Firebase Hosting (static)
```bash
npm install -g firebase-tools
firebase login
firebase deploy        # publishes public/ to https://arikia.web.app
```
On static hosting there's no server, so each user pastes their own Ollama Cloud key in **Settings**
(calls go straight to ollama.com from the browser).

---

## 3. Run locally
```bash
npm install
node server.js         # http://localhost:5000  (set AI keys as env vars first)
```
The app auto-detects whether a backend (`/api`) is present: if so, keys live server-side;
otherwise you enter them in Settings.

---

## Notes
- The **landing page** is `index.html` (served at `/`); the **chat app** is `app.html` (served at `/app`). Root copies mirror the `public/` versions, which is what gets served.
- The landing page is a **curated directory**: the website list lives in Firestore at `hub/main` and is **public to read** but **only admins can edit it**. Sign in via the **Sign in** button on the homepage with an admin account to reveal the add/edit/remove controls; everyone else sees a read-only directory. Sites are grouped into **categories** and each entry carries an optional **image** (defaults to the site's favicon).
- **Admins can reorder categories** with the ▲/▼ buttons on each category header (saved as `catOrder` in `config/app`), and **edit any page text** — eyebrow, hero tagline, the Who/What/Why cards, the directory heading and footer — via the **Edit text** button (inline editing, saved as `config/app.content`). The brand name/title still comes from the chat app's admin panel.
- **AI-assisted import:** the admin **Import bookmarks** button accepts pasted links *or just site names* (and exported browser-bookmark HTML). With **Enhance with ARIA** on, it calls the same Ollama Cloud proxy the chat app uses (`/api/ollama/v1/chat/completions`) to resolve canonical URLs, auto-sort into categories, write short descriptions, and attach icons. If the proxy/model can't be reached it falls back to a plain import of any entries that already have a URL, so a paste is never lost.
- **Admin accounts** are defined in three places that must stay in sync: `ADMIN_EMAILS` in `index.html`/`public/index.html`, `ADMIN_EMAILS` in `app.html`/`public/app.html`, and the `isHubAdmin()` list in the Firestore rules. Current admins: `kingasd8970@gmail.com`, `fanegf837@gmail.com`, `kingfan837@gmail.com`.
- **Site-wide admin controls** live in the chat app under **Settings → Admin controls** (visible only to admins) and are stored in Firestore at `config/app` (public read, admin-only write). From there an admin can, for everyone: change the **active model**, post an **announcement popup**, set a **locked system prompt** (when locked, every user's prompt is enforced and their own System Prompt box becomes read-only until the admin presses Save), set the **app/homepage name and tagline**, and set the **default theme & accent color**.
- **Locked-prompt enforcement** has two layers. The panel toggle enforces the prompt in the browser (read-only box). For true server-side enforcement that a user can't bypass, the `/api/ollama` proxy rewrites the system message on every chat request — driven by either host env vars (`LOCK_SYSTEM_PROMPT=1` + `LOCKED_SYSTEM_PROMPT=...`, always reliable) or, if you set an **unrestricted** `FIREBASE_API_KEY`, the panel's saved prompt read from Firestore. (The default web API key is referrer-restricted, so the server can't use it.)
- **Web search** runs through the server (`/api/search`, scraping DuckDuckGo's HTML/Lite endpoints) because browsers can't call search engines directly (CORS). On a static host with no server, search is unavailable and ARIA answers from its own knowledge. Both the homepage and the chat app subscribe to this config live. Per-user message limits (the "ban"/quota controls) remain at `limits/{uid}` and admins bypass them.
- Per-user data is stored as `memories/{uid}` and `chats/{uid}` in Firestore; local storage is the offline cache.
- DRM streaming and a full in-app web browser are intentionally **not** included — this app is focused on AI.
