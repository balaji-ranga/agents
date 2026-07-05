# Fix: "gateway closed (1008): pairing required"

When chat or delegation fails with:

```json
{ "status": "error", "error": "gateway closed (1008): pairing required\nGateway target: ws://127.0.0.1:18789\n..." }
```

the OpenClaw gateway is rejecting the connection because **device pairing** is required. The backend (and any client) must either use token auth or have the connecting device approved.

## Fix: use token auth (recommended)

1. **Edit** your OpenClaw config:
   - Path: `~/.openclaw/openclaw.json` (Windows: `C:\Users\<you>\.openclaw\openclaw.json`).
   - Add under `gateway`:
     ```json
     "auth": { "token": "your-secret-token-here" }
     ```
   - Optionally for local-only control UI: `"controlUi": { "allowInsecureAuth": true }`.
   - Example merged snippet:
     ```json
     "gateway": {
       "mode": "local",
       "port": 18789,
       "auth": { "token": "your-secret-token-here" },
       "http": { "endpoints": { "chatCompletions": { "enabled": true } } }
     }
     ```

2. **Set the same token** in the Agent OS backend `.env`:
   ```
   OPENCLAW_GATEWAY_TOKEN=your-secret-token-here
   ```

3. **Restart the gateway**: `openclaw gateway --port 18789`.

The backend sends `Authorization: Bearer <token>` on every request to the gateway; with this config the gateway will accept the connection and chat/delegation will work.

## Alternative: approve the device

If you prefer not to use a token:

1. Run `openclaw devices list` and note any pending request IDs.
2. Run `openclaw devices approve <request-id>` for the client that needs access.
3. Retry the chat or delegation.

See [OpenClaw gateway troubleshooting](https://docs.openclaw.ai/gateway/troubleshooting) for more (pairing, device identity, auth).
