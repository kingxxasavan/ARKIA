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
       // Curated homepage directory: anyone can read, only the admin can write.
       match /hub/{docId} {
         allow read: if true;
         allow write: if request.auth != null
                      && request.auth.token.email == 'kingasd8970@gmail.com';
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
2. **Settings → Environment Variables** — set your Ollama Cloud key so calls are proxied server-side:

   | Variable | Where to get it |
   |----------|-----------------|
   | `OLLAMA_KEY` | ollama.com/settings/keys |

3. Deploy, then add the Vercel domain to Firebase **Authorized domains** (step 1.3).

With the key set, `server.js` proxies the GLM-4.6 calls server-side (no key in the browser).

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
- The landing page is a **curated directory**: the website list lives in Firestore at `hub/main` and is **public to read** but **only the admin can edit it**. The admin is the account whose email is `kingasd8970@gmail.com` — sign in via the **Sign in** button on the homepage to reveal the add/edit/remove controls. Everyone else sees a read-only directory. (To change the admin, update `ADMIN_EMAIL` in `index.html` / `public/index.html` and the email in the `hub` Firestore rule.)
- Per-user data is stored as `memories/{uid}` and `chats/{uid}` in Firestore; local storage is the offline cache.
- DRM streaming and a full in-app web browser are intentionally **not** included — this app is focused on AI.
