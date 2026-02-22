# Configure OpenClaw to use Claude Opus

## 1. Set the model in config

Edit **`~/.openclaw/openclaw.json`** (on Windows: `C:\Users\balaj\.openclaw\openclaw.json`).

Add a **`model`** block under **`agents.defaults`** so the file includes:

```json
"agents": {
  "defaults": {
    "workspace": "~/.openclaw/workspace",
    "model": {
      "primary": "anthropic/claude-opus-4-6"
    }
  }
}
```

So the full `agents` section might look like:

```json
"agents": {
  "defaults": {
    "workspace": "~/.openclaw/workspace",
    "compaction": { "mode": "safeguard" },
    "model": { "primary": "anthropic/claude-opus-4-6" }
  }
}
```

Save the file. If the gateway is running, it will reload the config automatically.

## 2. Set your Anthropic API key

OpenClaw needs an Anthropic API key to call Claude.

**Option A — Environment variable (recommended)**

- Set **`ANTHROPIC_API_KEY`** to your key, e.g.:
  - PowerShell: `$env:ANTHROPIC_API_KEY = "sk-ant-..."`
  - Or add it in **System Properties → Environment Variables** (user or system).
- Restart the gateway (or start it in a terminal where the variable is set).

**Option B — OpenClaw onboarding**

```bash
openclaw onboard --auth-choice token
```

Then paste your Anthropic setup token when prompted.

**Option C — Paste token via CLI**

```bash
openclaw models auth paste-token --provider anthropic
```

Paste your setup token when prompted.

## 3. Optional: set via CLI

You can also set the default model from the CLI:

```bash
openclaw models set anthropic/claude-opus-4-6
openclaw models list
```

## Model IDs (Anthropic)

| Model ID | Description |
|----------|-------------|
| `anthropic/claude-opus-4-6` | Claude Opus (best for complex tasks) |
| `anthropic/claude-sonnet-4-5` | Claude Sonnet (faster, lower cost) |
| `anthropic/claude-haiku-4-5` | Claude Haiku (fast, cheap) |

## Optional: fallback models

To add fallbacks if the primary model is rate-limited or down:

```json
"model": {
  "primary": "anthropic/claude-opus-4-6",
  "fallbacks": ["anthropic/claude-sonnet-4-5"]
}
```

## Reference

- [Model providers](https://docs.openclaw.ai/concepts/model-providers) — Anthropic and other providers
- [Configuration](https://docs.openclaw.ai/gateway/configuration) — config file reference
