# Create agent-os repo on GitHub and push code

GitHub CLI (`gh`) is not required. Use the GitHub website and Git.

## 1. Create the new repository on GitHub

1. Go to **https://github.com/new**
2. **Repository name:** `agent-os`
3. **Description (optional):** e.g. "Web platform for OpenClaw agents — org chart, standup chat, COO delegation"
4. Choose **Public** (or Private).
5. **Do not** check "Add a README", ".gitignore", or "License" — you already have these in the folder.
6. Click **Create repository**.

## 2. Push agent-os code from your machine

From the **agents** repo (parent of `agent-os`), you can push only the `agent-os` folder to the new repo using a separate remote and a branch that has only agent-os history (or use subtree).

### Option A — New clone and copy (simplest)

1. Clone your **new empty** repo and copy agent-os contents into it:

   ```powershell
   cd c:\Users\balaj\projects
   git clone https://github.com/YOUR_USERNAME/agent-os.git agent-os-repo
   cd agent-os-repo
   ```

2. Copy everything from `agents\agent-os` into `agent-os-repo` **except** `.git` (so you don't overwrite the new repo's `.git`). Exclude:
   - `agent-os/backend/node_modules`
   - `agent-os/frontend/node_modules`
   - `agent-os/backend/.env`

   Example (PowerShell), from `c:\Users\balaj\projects\agents`:

   ```powershell
   robocopy agent-os agent-os-repo /E /XD node_modules .git backend\node_modules frontend\node_modules /XF backend\.env
   ```
   Then copy the contents of `agent-os-repo` so the repo root has `backend/`, `frontend/`, `README.md`, etc. Or manually copy the agent-os folders and files into `agent-os-repo`, leaving out `node_modules` and `backend\.env`.

3. Commit and push:

   ```powershell
   cd c:\Users\balaj\projects\agent-os-repo
   git add -A
   git status   # confirm no .env and no node_modules
   git commit -m "Initial commit: Agent OS — OpenClaw agent space"
   git push -u origin main
   ```

### Option B — Push from current repo (subtree)

`agent-os` is currently a subfolder of the `agents` repo. You can push only that folder as the new repo:

1. Commit `agent-os` in the agents repo (agent-os/.gitignore keeps .env and node_modules out):

   ```powershell
   cd c:\Users\balaj\projects\agents
   git add agent-os
   git status   # confirm no backend/.env, no node_modules
   git commit -m "Add agent-os for separate GitHub repo"
   ```

2. Add the new GitHub repo as a remote and push the subtree:

   ```powershell
   git remote add agent-os https://github.com/YOUR_USERNAME/agent-os.git
   git subtree push --prefix=agent-os agent-os main
   ```

Replace `YOUR_USERNAME` with your GitHub username. If your default branch is `master`, use `master` instead of `main`. This pushes the contents of `agent-os` as the root of the new repo.

## 3. Security check before push

- **Never commit `backend/.env`.** It contains `OPENCLAW_GATEWAY_TOKEN` and `OPENAI_API_KEY`. The new `agent-os/.gitignore` ignores `.env`.
- If you use Option A, do not copy `backend\.env` into the new clone.
- In the new repo, rely on `backend/.env.example`; each environment should copy it to `.env` and fill in values locally.

## 4. After the repo is created

- Add a **Topics** on GitHub (e.g. `openclaw`, `agents`, `node`, `react`).
- If the repo is public, the URL will be: `https://github.com/YOUR_USERNAME/agent-os`
