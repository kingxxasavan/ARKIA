# ARIA — Personal AI Assistant

A clean, multi-provider AI chat app with **accounts** (Firebase) and **per-user memory + chat history** that follow you across devices. Supports Claude, OpenAI, Ollama Cloud, and OpenRouter.

- **Accounts** — email/password + Google sign-in (Firebase Auth)
- **Memory** — ARIA builds a profile of your preferences, tasks, and projects, saved to your account
- **Chat history** — conversations sync to your account (Firestore)
- **Importable features** — Calendar, Reminders, Notes, plus custom list tools the AI can read/write
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
     }
   }
   ```
3. **Authentication → Settings → Authorized domains** → add every domain you serve from, e.g.
   `arikia.web.app`, `arikia.firebaseapp.com`, your `*.vercel.app` domain, and any custom domain.
   *(Login is blocked on domains not listed here.)*

---

## 2. Deploy

### Option A — Vercel
1. Import this repo in Vercel (it auto-detects `vercel.json`).
2. **Settings → Environment Variables** — add the AI keys you want kept server-side:

   | Variable | Where to get it |
   |----------|-----------------|
   | `ANTHROPIC_KEY` | console.anthropic.com |
   | `OPENAI_KEY` | platform.openai.com/api-keys |
   | `OLLAMA_KEY` | ollama.com/settings/keys |
   | `OPENROUTER_KEY` | openrouter.ai/keys (free) |

3. Deploy, then add the Vercel domain to Firebase **Authorized domains** (step 1.3).

With keys set, `server.js` proxies AI calls server-side (no keys in the browser).

### Option B — Firebase Hosting (static)
```bash
npm install -g firebase-tools
firebase login
firebase deploy        # publishes public/ to https://arikia.web.app
```
On static hosting there's no server, so each user enters their own AI key in **Settings**
(Claude / OpenAI / OpenRouter work directly from the browser).

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
- `index.html` and `public/index.html` are kept identical — `public/` is what Firebase Hosting serves.
- Per-user data is stored as `memories/{uid}` and `chats/{uid}` in Firestore; local storage is the offline cache.
- DRM streaming and a full in-app web browser are intentionally **not** included — this app is focused on AI.
