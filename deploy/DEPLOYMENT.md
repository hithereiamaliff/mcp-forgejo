# Forgejo MCP: VPS deployment guide

Deploys the server behind nginx with Docker, mounted at:

```text
https://mcp.techmavie.digital/forgejo
```

| Item | Value |
|---|---|
| Directory on VPS | `/opt/mcp-servers/forgejo` |
| Container | `mcp-forgejo` |
| Host port | `127.0.0.1:8098` (8083–8097 are taken by other MCPs; check with `ss -tlnp \| grep ':8098'`) |
| Docker network | `mcp-network` (external, shared with `mcp-key-service`) |
| Key-service server ID | `forgejo` |

## Auth modes

| Mode | Endpoint | Client sends |
|---|---|---|
| Hosted (recommended) | `POST /forgejo/mcp/usr_...` | Personal key from mcpkeys.techmavie.digital in the path |
| Hosted (header) | `POST /forgejo/mcp` | `Authorization: Bearer usr_...` or `X-API-Key: usr_...` |
| Hosted (compatibility) | `POST /forgejo/mcp?api_key=usr_...` | Personal key in the query string |
| Self-hosted | `POST /forgejo/mcp` | `X-API-Key: <MCP_API_KEY>` + `X-Forgejo-Url` + `X-Forgejo-Token` |
| Diagnostics | `POST /forgejo/mcp-debug/open` | Nothing (only when `ENABLE_MCP_DIAGNOSTICS=true`) |

Every mode also accepts `?toolsets=default,actions,...` / `?read_only=true` (or the `X-Forgejo-Toolsets` / `X-Forgejo-Read-Only` headers).

## One-time setup

Do these in order. Steps 1–2 register the server with mcp-key-service; without both halves the key service answers 401/403.

### 1. Create the key-service token

```bash
ssh <user>@<vps>
openssl rand -hex 32        # copy the output: this is FORGEJO_TOKEN below
```

Append it to `INTERNAL_SERVER_TOKENS` in `/opt/mcp-key-service/.env` (comma-separated, keep the existing entries):

```env
INTERNAL_SERVER_TOKENS=...existing entries...,forgejo:<FORGEJO_TOKEN>
```

### 2. Deploy mcp-key-service with the `forgejo` connector

Merge the mcp-key-service PR that adds the `forgejo` connector. Its workflow redeploys the key service, which also picks up the new token from `.env`. You can also run `cd /opt/mcp-key-service && docker compose up -d --build` by hand. Check that **Forgejo** now appears in the connection form on https://mcpkeys.techmavie.digital.

### 3. Create this server's `.env`

```bash
sudo mkdir -p /opt/mcp-servers/forgejo
cd /opt/mcp-servers/forgejo
git clone https://github.com/hithereiamaliff/mcp-forgejo.git .
cp .env.sample .env
nano .env
```

```env
KEY_SERVICE_URL=http://mcp-key-service:8090/internal/resolve
KEY_SERVICE_TOKEN=<FORGEJO_TOKEN>          # same value as in step 1
MCP_API_KEY=<openssl rand -hex 32>         # protects /analytics and self-hosted mode
```

Leave `FORGEJO_URL` and `FORGEJO_ACCESS_TOKEN` empty on the hosted server: every user brings their own instance and token through the key service. Keep `FORGEJO_ALLOW_HTTP` and `FORGEJO_ALLOW_PRIVATE_HOSTS` off. They exist for private single-user deployments, and on a shared server they would let users reach internal services.

### 4. Check the port is free and start the container

```bash
ss -tlnp | grep ':8098' || echo "8098 is free"
docker network inspect mcp-network >/dev/null 2>&1 || docker network create mcp-network
docker compose up -d --build
docker compose logs -f
```

### 5. Add the nginx location block

Copy [nginx-mcp.conf](./nginx-mcp.conf) into the `server { }` block for `mcp.techmavie.digital`:

```bash
sudo nano /etc/nginx/sites-available/mcp.techmavie.digital
sudo nginx -t && sudo systemctl reload nginx
```

### 6. Enable auto-deploy

The workflow in `.github/workflows/deploy-vps.yml` runs the tests and then deploys on every push to `main`. Add these repository secrets (same values as your other MCP repos):

| Secret | Value |
|---|---|
| `VPS_HOST` | VPS IP or hostname |
| `VPS_USERNAME` | SSH user |
| `VPS_SSH_KEY` | Private SSH key |
| `VPS_PORT` | SSH port (optional, defaults to 22) |

## Your own Forgejo on the same VPS

`git.mynameisaliff.co.uk` runs on the same server. The container reaches it through its public DNS name, which normally works (traffic goes out through Docker's NAT to the host's public IP, where nginx answers).

If `forgejo_hello` reports a timeout or connection refused for your own instance, the VPS doesn't support hairpin NAT. In that case:

1. Uncomment `extra_hosts` in `docker-compose.yml` (`git.mynameisaliff.co.uk:host-gateway`).
2. Set `FORGEJO_TRUSTED_HOSTS=git.mynameisaliff.co.uk` in `.env`. This lets the container reach it through the Docker host address, which the SSRF guard would otherwise refuse as private.
3. Run `docker compose up -d`.

## Verification sequence

```bash
BASE=https://mcp.techmavie.digital/forgejo
```

1. Health:

   ```bash
   curl $BASE/health
   ```

2. Server card (lists all 118 tools with their toolsets):

   ```bash
   curl -s $BASE/.well-known/mcp/server-card.json | head -c 600
   ```

3. Missing auth should return 401 with instructions:

   ```bash
   curl -s -X POST $BASE/mcp -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

4. Hosted mode, after creating a Forgejo connection at https://mcpkeys.techmavie.digital. `forgejo_hello` shows the instance version and your user:

   ```bash
   curl -s -X POST $BASE/mcp/usr_YOUR_KEY \
     -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"forgejo_hello","arguments":{}}}'
   ```

5. Toolsets and read-only mode:

   ```bash
   curl -s -X POST "$BASE/mcp/usr_YOUR_KEY?toolsets=all&read_only=true" \
     -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -o '"name":"forgejo_[a-z_]*"' | wc -l
   ```

6. Self-hosted headers:

   ```bash
   curl -s -X POST $BASE/mcp \
     -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
     -H "X-API-Key: YOUR_MCP_API_KEY" -H "X-Forgejo-Url: https://git.mynameisaliff.co.uk" -H "X-Forgejo-Token: YOUR_FORGEJO_TOKEN" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"forgejo_hello","arguments":{}}}'
   ```

7. Analytics: the first call should return 401, the second should return 200:

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" $BASE/analytics
   curl -s $BASE/analytics -H "X-API-Key: YOUR_MCP_API_KEY" | head -c 400
   ```

   Dashboard: https://mcp.techmavie.digital/forgejo/analytics/dashboard

## Client configuration

Claude.ai / Claude Desktop (custom connector), Claude Code, Cursor, Windsurf and others:

```text
https://mcp.techmavie.digital/forgejo/mcp/usr_YOUR_KEY
```

```json
{
  "mcpServers": {
    "forgejo": {
      "type": "http",
      "url": "https://mcp.techmavie.digital/forgejo/mcp/usr_YOUR_KEY?toolsets=default,actions"
    }
  }
}
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401 missing_auth` | No usr_ key in the URL and no self-hosted headers. |
| `403 invalid_key` | The usr_ key is wrong, revoked, suspended (e.g. expired subscription), or belongs to another connector. Check the portal. |
| `502 malformed_response` | The saved connection is missing the instance URL or token. Re-save it in the portal. |
| `503 service_unavailable` | The key service is unreachable **or rejected this server's token**. Check that `KEY_SERVICE_TOKEN` equals the `forgejo:` entry in the key service's `INTERNAL_SERVER_TOKENS`, that `KEY_SERVICE_URL` ends in `/internal/resolve`, and that both containers are on `mcp-network` (`docker network inspect mcp-network`). |
| `400 invalid_toolsets` | Unknown name in `?toolsets=`. The error lists the valid names. |
| Tool error "http:// is not allowed" / "private or internal address" | The saved instance URL is `http://`, or resolves to a private IP. The hosted server only talks to public HTTPS instances. For your own instance on this VPS, see the hairpin section above. |
| Tool error "redirected … update it" | The instance URL redirects (http→https, www, sub-path). Save the final URL in the portal. |
| Tool error "missing the scope(s) …" | The Forgejo token lacks a scope. Create a new token with it and update the connection. |
| Tool error "needs Forgejo 16.0 or newer" | That Actions feature isn't in the instance's version yet. |
| Container exits immediately | Read `docker compose logs`. Common causes: only one of `KEY_SERVICE_URL` / `KEY_SERVICE_TOKEN` is set, or an invalid `FORGEJO_TOOLSETS`. |
| Empty `initialize` responses in a client | Set `MCP_TRACE_HTTP=true`, restart, and check the logs. Enable `ENABLE_MCP_DIAGNOSTICS=true` to test transport with `/mcp-debug/open`. |

## Useful commands

```bash
cd /opt/mcp-servers/forgejo
docker compose ps
docker compose logs -f --tail=100
docker compose restart
docker compose up -d --build          # rebuild after manual changes
docker volume inspect forgejo_analytics-data
```
