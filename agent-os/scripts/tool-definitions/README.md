# API tool definitions for onboarding

Use with `node scripts/onboard-api-tool.js scripts/tool-definitions/<file>.json`.

## JSON schema

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Tool name (lowercase, underscores; e.g. `forex_rates`) |
| `description` | Yes | Purpose shown to the agent |
| `endpoint` | Yes | Full URL (e.g. `https://api.example.com/v1/action`) or backend path (e.g. `/api/tools/...`) |
| `method` | No | `GET` or `POST` (default `POST`) |
| `api_key_bearer` | No | Bearer token for auth (sent as `Authorization: Bearer <value>`) |
| `applicable_agents` | Yes | `"All"` or array of agent ids (e.g. `["expensemanager", "techresearcher"]`) |

## Examples

- **forex-rates.json** – Frankfurter API (public), GET, only ExpenseManager.
- **forex-rates-techresearcher.json** – Same tool, add TechResearcher (merge).

After onboarding, restart the OpenClaw gateway so agents see the new tool.
