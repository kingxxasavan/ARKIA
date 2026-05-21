# ARIA — Personal AI Assistant

A local/hosted AI assistant with memory, importable features (calendar, reminders, notes), a built-in browser, and support for Claude, OpenAI, Ollama Cloud, and OpenRouter.

-----

## Deploy on Replit (recommended)

1. **Import this repo** — on Replit, click **+ Create Repl → Import from GitHub** and paste this repo URL
1. **Add your API keys** — open the **Secrets** tab (padlock icon in the sidebar) and add whichever keys you have:
   
   |Secret name     |Where to get it                          |
   |----------------|-----------------------------------------|
   |`ANTHROPIC_KEY` |console.anthropic.com                    |
   |`OPENAI_KEY`    |platform.openai.com/api-keys             |
   |`OLLAMA_KEY`    |ollama.com/settings/keys                 |
   |`OPENROUTER_KEY`|openrouter.ai/keys (free, no credit card)|
1. **Run** — Replit will auto-run `npm install && node server.js`. Click the URL it gives you.

That’s it. All API calls happen server-side so there are no CORS issues — Ollama Cloud and OpenAI work directly.

-----

## Run locally

```bash
git clone <this-repo>
cd aria
cp .env.example .env        # fill in your keys
npm install
node server.js              # open http://localhost:5000
```

Or just open `public/index.html` directly in your browser — it works as a plain HTML file too (keys stored in browser localStorage, direct API calls).

-----

## Features

- **4 AI providers** — Claude, OpenAI, Ollama Cloud, OpenRouter
- **Memory** — ARIA learns facts about you across conversations
- **Built-in browser** — split-panel browser that loads any site through the server proxy; **→ ARIA** button sends page text into the chat
- **Importable features** — Calendar, Reminders, Notes, plus custom list features the AI can read and write
- **Dark mode** — toggle in the sidebar
- **Web search** — live search attached to every response