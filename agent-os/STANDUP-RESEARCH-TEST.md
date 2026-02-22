# Standup → COO → TechResearcher Test

This test validates: **COO had a standup with inputs on topics for LinkedIn "AI for Finance industry" → COO messages TechResearcher to do research and come back with topics → COO summarizes for CEO Bala.**

## Prerequisites

- **Backend** running (`cd backend && npm run dev`)
- **OpenClaw gateway** running (`openclaw gateway --port 18789`) so TechResearcher can reply
- **OPENAI_API_KEY** set in backend `.env` for COO summarization
- TechResearcher and COO (BalServe) in DB: run `node scripts/ensure-techresearcher.js` and `node scripts/seed-all.js` if needed

## Run automated test

From the **backend** folder:

```bash
node scripts/run-standup-research-test.js
```

Steps performed:

1. Create standup with topic: AI for Finance industry (LinkedIn research).
2. Add standup response (topics for research for LinkedIn).
3. Run COO summarization on standup (requires OPENAI_API_KEY).
4. COO messages TechResearcher via `POST /agents/techresearcher/chat/from-agent` (requires gateway).
5. Add TechResearcher reply to standup and run COO again for CEO summary.

View the standup in the Dashboard at http://127.0.0.1:3000.

## Manual alternative

1. **Dashboard** → Create standup (pick date/time) → add a response with content: "Topics for research for publish to LinkedIn: AI for Finance industry."
2. Click **Run COO** to get COO/CEO summary.
3. **Chat** → open TechResearcher → send: "From our standup we need research and 3–5 talking points for a LinkedIn post on AI for Finance industry. Please research and reply with angles we can use."
4. Copy TechResearcher’s reply, add it as another response to the standup (or create a new standup), then **Run COO** again for the final summary for Bala.

## Agent-to-agent (COO → TechResearcher)

The backend supports **COO messaging TechResearcher** via:

- **API:** `POST /agents/techresearcher/chat/from-agent` with body `{ "from_agent_id": "balserve", "message": "..." }`
- **Frontend:** use `api.agentChatFromAgent('techresearcher', 'balserve', message)` (e.g. from a "Send from COO" button).

The message is stored in TechResearcher’s chat as "From BalServe (COO): ..." and the reply is returned and persisted.
