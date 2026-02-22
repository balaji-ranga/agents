# Standup flow — UI test checklist

Test from the **Dashboard** in the browser. No backend scripts required.

## Prerequisites

- Backend and frontend running. All API routes are under `/api`; the frontend proxies `/api` to the backend (or set `VITE_API_URL` to the backend base URL including `/api`).
- OpenClaw Gateway running (for COO chat and for "Get work from team" — delegation uses Gateway cron one-shot jobs that POST to the backend webhook).
- At least one agent in the org with COO set, and at least one delegated agent (e.g. TechResearcher).

## 1. Create standup → COO chat opens

- [ ] Open **Dashboard**.
- [ ] In **Standups**, set date/time and click **Create standup**.
- [ ] Right side shows **COO chat — [date/time]** and an empty message area.
- [ ] Placeholder text: "No messages yet. Send the day's tasks to the COO below."

## 2. Chat is specific to that standup

- [ ] Send a message in the chat (e.g. "Focus on research today").
- [ ] You see **You:** and **COO:** messages in the same chat.
- [ ] Select a **different** standup from the list (or create another).
- [ ] Chat content changes; the new standup has its own (possibly empty) history.
- [ ] Select the first standup again; your earlier messages and COO replies are still there.

## 3. Get work from team → updates in chat

- [ ] With a standup selected, click **Get work from team**.
- [ ] A COO reply appears in the chat (e.g. "I've asked the team...").
- [ ] Click **Check for updates** (or wait for cron to run).
- [ ] New COO messages appear in the **same** chat with agent updates (when cron has run and agents have responded).

## 4. Optional summary

- [ ] **Run COO summary** runs without error (may need agent responses in standup_responses for non-empty summary).
- [ ] If a summary exists, **Listen** reads it; **Summary** details section can be expanded to read COO/CEO text.

## 5. Open existing scheduled standup

- [ ] With at least one standup in the list, click it (do not create a new one).
- [ ] COO chat opens for that schedule with that standup’s messages only.
- [ ] Sending a message and using **Get work from team** / **Check for updates** keeps everything in this standup’s chat.

---

**Expected flow:** Create or open standup → COO chat is the main view → give tasks in chat → COO delegates via cron → child agent responses show up in this chat. Each standup has its own chat history.
