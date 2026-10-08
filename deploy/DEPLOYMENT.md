# Forgejo MCP: VPS deployment guide

Deploys the server behind nginx with Docker, mounted at:

```text
https://mcp.techmavie.digital/forgejo
```

Every command below is **copy-paste ready**. The server works out values such as the free port and the key-service token itself, and the risky steps make a backup and roll back automatically. These commands were used for the first production deploy on 2026-10-08 (see [Production record](#production-record-2026-10-08)). Run them as `root` over SSH.

| Item | Value |
|---|---|
| Directory on VPS | `/opt/mcp-servers/forgejo` |
| Container | `mcp-forgejo` (internal port 8080) |
| Host port | `127.0.0.1:${MCP_HOST_PORT}`, set in `/opt/mcp-servers/forgejo/.env` (default `8099`; production uses **8100**) |
| Docker network | `mcp-network` (external, shared with `mcp-key-service`) |
| Key-service server ID | `forgejo` |
| nginx | `location /forgejo/` in `/etc/nginx/sites-available/mcp.techmavie.digital` |

## Auth modes

| Mode | Endpoint | Client sends |
|---|---|---|
| Hosted (recommended) | `POST /forgejo/mcp/usr_...` | Personal key from mcpkeys.techmavie.digital in the path |
| Hosted (header) | `POST /forgejo/mcp` | `Authorization: Bearer usr_...` or `X-API-Key: usr_...` |
| Hosted (compatibility) | `POST /forgejo/mcp?api_key=usr_...` | Personal key in the query string |
| Self-hosted | `POST /forgejo/mcp` | `X-API-Key: <MCP_API_KEY>` + `X-Forgejo-Url` + `X-Forgejo-Token` |
| Diagnostics | `POST /forgejo/mcp-debug/open` | Nothing (only when `ENABLE_MCP_DIAGNOSTICS=true`) |

Every mode also accepts `?toolsets=default,actions,...` and `?read_only=true` (or the `X-Forgejo-Toolsets` / `X-Forgejo-Read-Only` headers).

---

## One-time setup

Do the steps in order. Steps 1–2 register this server with mcp-key-service. Until both are done, the key service answers 401/403.

### 1. Register a key-service token for `forgejo`

Generate a token and keep it in your password manager. You won't need to retype it later, because step 4c reads it from the key-service `.env`:

```bash
openssl rand -hex 32
```

Back up the key-service settings, then add the token:

```bash
cp /opt/mcp-key-service/.env /opt/mcp-key-service/.env.backup
```

```bash
nano /opt/mcp-key-service/.env
```

In nano:
1. Press **Ctrl+W**, type `INTERNAL_SERVER_TOKENS` and press **Enter**.
2. Press **End**, then type `,forgejo:` and paste the token (no spaces, no quotes).
3. Save with **Ctrl+O** and **Enter**, then exit with **Ctrl+X**.

Check the result without printing any tokens. The first command must list `forgejo`, with each name appearing once:

```bash
grep '^INTERNAL_SERVER_TOKENS=' /opt/mcp-key-service/.env | cut -d= -f2- | tr ',' '\n' | cut -d: -f1
```

The second must print `0` (no spaces on the line):

```bash
grep '^INTERNAL_SERVER_TOKENS=' /opt/mcp-key-service/.env | tr -cd ' ' | wc -c
```

The key service only reads this list when it starts. Restart it now so that a typo shows up immediately:

```bash
cd /opt/mcp-key-service && docker compose up -d --force-recreate mcp-key-service
```

Then check that it's healthy:

```bash
curl -s http://127.0.0.1:8090/health
```

If it doesn't come back healthy, restore the backup:

```bash
cp /opt/mcp-key-service/.env.backup /opt/mcp-key-service/.env && cd /opt/mcp-key-service && docker compose up -d --force-recreate mcp-key-service
```

### 2. Deploy mcp-key-service with the `forgejo` connector

Merge the mcp-key-service change that adds the connector ([hithereiamaliff/mcp-key-service#2](https://github.com/hithereiamaliff/mcp-key-service/pull/2), already merged). Its workflow redeploys the key service. Then check that **Forgejo (self-hosted or Codeberg)** appears on https://mcpkeys.techmavie.digital.

### 3. Add the GitHub Actions secrets (before the first merge to `main`)

Merging to `main` runs `.github/workflows/deploy-vps.yml`, which logs into the VPS with these repository secrets. Add them under **Settings → Secrets and variables → Actions**:

| Secret | Value | How to find it on the VPS |
|---|---|---|
| `VPS_HOST` | Public IP | `curl -4 -s ifconfig.me` |
| `VPS_USERNAME` | SSH user | `root` |
| `VPS_PORT` | SSH port (optional, default 22) | `sshd -T \| grep '^port '` |
| `VPS_SSH_KEY` | Private key of a deploy key | see below |

GitHub never shows a secret again after it's saved, so you can't copy the key from another repo. Create a dedicated deploy key for this one:

```bash
ssh-keygen -t ed25519 -C "github-actions-mcp-forgejo" -f /root/.ssh/gha_mcp_forgejo -N ""
```

```bash
cat /root/.ssh/gha_mcp_forgejo.pub >> /root/.ssh/authorized_keys
```

Check that the key can log in (it should print `ok`):

```bash
ssh -i /root/.ssh/gha_mcp_forgejo -o StrictHostKeyChecking=no root@127.0.0.1 echo ok
```

Show the private key so you can copy it:

```bash
cat /root/.ssh/gha_mcp_forgejo
```

Paste the whole private key, including the `BEGIN` and `END` lines, into the `VPS_SSH_KEY` secret. Never paste it into a chat. Then remove the server's copy; the `.pub` entry in `authorized_keys` is all the server needs:

```bash
rm /root/.ssh/gha_mcp_forgejo
```

### 4. Prepare the VPS

Run these **in the same terminal session**, because step 4a stores the port in `$FJ_PORT` for the later steps.

**4a. Find a free host port.** It skips ports that are already listening or already used in the nginx config:

```bash
FJ_PORT=$(for p in $(seq 8099 8150); do ss -tlnH "sport = :$p" | grep -q . && continue; grep -qsE "127\.0\.0\.1:$p[/;]" /etc/nginx/sites-available/mcp.techmavie.digital && continue; echo $p; break; done); echo "FORGEJO PORT: $FJ_PORT"
```

**4b. Clone the repo.** The deploy workflow expects the folder to already be a git checkout:

```bash
git clone https://github.com/hithereiamaliff/mcp-forgejo.git /opt/mcp-servers/forgejo
```

**4c. Create `.env` automatically.** It reads the `forgejo` token from the key-service `.env`, generates the analytics secret and records the port:

```bash
FJ_TOKEN=$(grep '^INTERNAL_SERVER_TOKENS=' /opt/mcp-key-service/.env | cut -d= -f2- | tr -d '"' | tr ',' '\n' | grep '^forgejo:' | cut -d: -f2-) && [ ${#FJ_TOKEN} -eq 64 ] && printf 'KEY_SERVICE_URL=http://mcp-key-service:8090/internal/resolve\nKEY_SERVICE_TOKEN=%s\nMCP_API_KEY=%s\nMCP_HOST_PORT=%s\n' "$FJ_TOKEN" "$(openssl rand -hex 32)" "$FJ_PORT" > /opt/mcp-servers/forgejo/.env && chmod 600 /opt/mcp-servers/forgejo/.env && echo ".env written (port $FJ_PORT)" || echo "PROBLEM: could not read the forgejo token from the key service .env"
```

On the hosted server, leave `FORGEJO_URL`, `FORGEJO_ACCESS_TOKEN`, `FORGEJO_ALLOW_HTTP` and `FORGEJO_ALLOW_PRIVATE_HOSTS` unset:
- Users bring their own instance and token through the key service.
- Relaxing the network policy on a shared server would let users reach internal services.

**4d. Add the nginx route** right after the `/zerobounce/` block. First back up the config:

```bash
cp /etc/nginx/sites-available/mcp.techmavie.digital /etc/nginx/sites-available/mcp.techmavie.digital.bak-forgejo
```

Write the location block (using the port from 4a) to a temporary file. The last line should show `proxy_pass` with your port:

```bash
cat > /tmp/forgejo-location.conf <<EOF
    # Forgejo MCP Server (mcp-forgejo v3) - container on 127.0.0.1:$FJ_PORT
    location /forgejo/ {
        proxy_pass http://127.0.0.1:$FJ_PORT/;
        proxy_http_version 1.1;

        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";

        proxy_connect_timeout 60s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;

        proxy_buffering off;
        proxy_cache off;
        proxy_request_buffering off;

        client_max_body_size 12M;

        # Keep usr_ keys out of the access log
        access_log off;
    }
EOF
grep -n "proxy_pass" /tmp/forgejo-location.conf
```

Insert it into the config. This prints the line number where `location /forgejo/` landed:

```bash
awk 'FNR==NR{blk=blk $0 "\n"; next} {print} /location \/zerobounce\/ \{/{inzb=1} inzb && /^[[:space:]]*}[[:space:]]*$/{printf "\n%s", blk; inzb=0}' /tmp/forgejo-location.conf /etc/nginx/sites-available/mcp.techmavie.digital > /tmp/mcp.techmavie.digital.new && mv /tmp/mcp.techmavie.digital.new /etc/nginx/sites-available/mcp.techmavie.digital && grep -n "location /forgejo/" /etc/nginx/sites-available/mcp.techmavie.digital
```

Test and reload. If the test fails, the backup is restored automatically:

```bash
nginx -t && systemctl reload nginx && echo "RELOADED OK" || { cp /etc/nginx/sites-available/mcp.techmavie.digital.bak-forgejo /etc/nginx/sites-available/mcp.techmavie.digital; echo "TEST FAILED - original config restored"; }
```

**4e. Check.** You should see `502` (the route is live but the container hasn't started yet), followed by `.env` and `.git`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://mcp.techmavie.digital/forgejo/health; ls -a /opt/mcp-servers/forgejo | grep -E '^\.env$|^\.git$'
```

If you get anything else, don't deploy yet:
- **`200`** means **another service already answers on that port**. This is how the clash on 8098 was found. Wait until the route returns 502.
- **`404`** means the nginx block isn't active.

### 5. Deploy

Merge to `main`. The workflow runs the typecheck and tests, then connects over SSH and:
1. runs `git reset --hard origin/main`
2. runs `docker compose build`, then `docker compose up -d`
3. checks `127.0.0.1:$MCP_HOST_PORT/health` for up to 60 seconds, and prints the logs if it fails

Changes that only touch Markdown files or `docs/` don't trigger a deploy.

---

## Verification sequence

```bash
BASE=https://mcp.techmavie.digital/forgejo
```

1. Health. Expect `"server":"Forgejo MCP Server"` and `"keyService":"configured"`:

   ```bash
   curl -s $BASE/health
   ```

2. Server card, which lists all 118 tools with their toolsets:

   ```bash
   curl -s $BASE/.well-known/mcp/server-card.json | head -c 600
   ```

3. Missing auth. Expect a 401 with instructions:

   ```bash
   curl -s -X POST $BASE/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

4. A made-up key. Expect "This key is invalid, revoked or suspended…". This proves the round trip to the key service works; a wrong `KEY_SERVICE_TOKEN` would give "temporarily unavailable" instead:

   ```bash
   curl -s -X POST $BASE/mcp/usr_00000000000000000000000000000000 -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

5. Analytics. Expect `401` without the key, and `200` for the dashboard page:

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" $BASE/analytics; curl -s -o /dev/null -w "%{http_code}\n" $BASE/analytics/dashboard
   ```

   The dashboard is at https://mcp.techmavie.digital/forgejo/analytics/dashboard. Log in with `MCP_API_KEY`, which this shows:

   ```bash
   grep MCP_API_KEY /opt/mcp-servers/forgejo/.env
   ```

6. End to end with your own connection (see [Connecting a client](#connecting-a-client)): `forgejo_hello` should show your instance version and user.

---

## Connecting a client

1. **Create a token.** On your Forgejo instance, go to **Settings → Applications → Generate New Token**.
   - Give it read/write for `repository`, `issue`, `notification` and `user`.
   - Add `organization`, `package` or `admin` if you want those toolsets.
   - On Forgejo 15+, deleting a repository through the API needs `write:user`.
2. **Create a connection.** On https://mcpkeys.techmavie.digital, add a **Forgejo** connection with the instance URL (e.g. `https://git.mynameisaliff.co.uk`) and the token, then copy the `usr_` key. Re-creating a connection (e.g. to change the token) issues a **new** key, and the old one stops working.
3. **Add a custom connector in Claude** (claude.ai, Claude Desktop or Claude Code) with one of these URLs:

   ```text
   https://mcp.techmavie.digital/forgejo/mcp/usr_YOUR_KEY
   https://mcp.techmavie.digital/forgejo/mcp/usr_YOUR_KEY?toolsets=default,repo_admin
   https://mcp.techmavie.digital/forgejo/mcp/usr_YOUR_KEY?toolsets=all
   https://mcp.techmavie.digital/forgejo/mcp/usr_YOUR_KEY?read_only=true
   ```

   The key goes directly after `/mcp/`, then a **`?`** before any options.

4. **Test it.** Ask Claude to run `forgejo_hello`.

### Changing toolsets on an existing connector

Remove the connector in Claude, then add it again with the new URL. Editing the URL of an existing connector can leave Claude with a stale sign-in state.

### "Sign in" prompt or connection errors

Claude shows a **sign-in** prompt whenever the server answers "not authenticated". This server has no OAuth login, so the prompt always means the URL is wrong:

| URL saved in Claude | Server answer | Fix |
|---|---|---|
| `…/forgejo/mcp?toolsets=…` (key missing) | 401 `missing_auth` | put `usr_KEY` after `/mcp/` |
| `…/mcp/usr_KEY&toolsets=…` (`&` instead of `?`) | 403 `invalid_key` | use `?` |
| an old key (the connection was re-created) | 403 `invalid_key` | copy the current key from the portal |
| `?toolset=…` or another typo in the option **name** | works, but only with the default tools | the parameter is `toolsets` (an unknown toolset **value** returns a clear 400) |

**Check a URL without sharing the key.** This uses a hidden prompt and works on any machine with `curl`:

```bash
read -rsp "Paste your full Forgejo MCP URL, then press Enter: " U; echo; curl -s -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"forgejo_hello","arguments":{}}}' "$U" | grep -o -E 'Enabled toolsets:[^\\]*|"message":"[^"]*"' | head -3; unset U
```

**Build a correct URL with extra toolsets from a working one.** This prints the URL to paste into Claude. To get different toolsets, change `default,repo_admin` in the command:

```bash
read -rsp "Paste your WORKING Forgejo MCP URL, then press Enter: " U; echo; BASE="${U%%\?*}"; NEW="$BASE?toolsets=default,repo_admin"; case "$U" in *api_key=*) NEW="$BASE?$(echo "${U#*\?}" | tr '&' '\n' | grep '^api_key=' | head -1)&toolsets=default,repo_admin";; esac; curl -s -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"forgejo_hello","arguments":{}}}' "$NEW" | grep -o -E 'Enabled toolsets:[^\\]*|"message":"[^"]*"' | head -3; echo; echo "Use this exact URL in Claude (do NOT paste it in chat):"; echo "$NEW"; unset U BASE NEW
```

---

## Your own Forgejo on the same VPS

`git.mynameisaliff.co.uk` runs on the same server. The container reaches it through its public address: the request goes out through Docker's network to the host's public IP, where nginx answers. This works on the current VPS (verified 2026-10-08).

A future VPS might not route traffic back to itself like this (called "hairpin NAT"). If so, `forgejo_hello` shows a timeout or "connection refused" for your own instance. Fix it with a `docker-compose.override.yml` next to `docker-compose.yml`, plus a trusted-host setting. The override file isn't tracked by git, so deploys don't overwrite it:

```bash
cd /opt/mcp-servers/forgejo && printf 'services:\n  mcp-forgejo:\n    extra_hosts:\n      - "git.mynameisaliff.co.uk:host-gateway"\n' > docker-compose.override.yml && grep -q '^FORGEJO_TRUSTED_HOSTS=' .env || echo 'FORGEJO_TRUSTED_HOSTS=git.mynameisaliff.co.uk' >> .env; docker compose up -d
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401 missing_auth`, or a "sign in" prompt in Claude | No `usr_` key in the URL. See [above](#sign-in-prompt-or-connection-errors). |
| `403 invalid_key` | The key is wrong, revoked, suspended (e.g. expired subscription) or belongs to another connector. Check the portal. |
| `502 malformed_response` | The saved connection is missing the instance URL or token. Re-save it in the portal. |
| `503 service_unavailable` | The key service is unreachable **or rejected this server's token**. Check that `KEY_SERVICE_TOKEN` equals the `forgejo:` entry in the key service's `INTERNAL_SERVER_TOKENS`, that `KEY_SERVICE_URL` ends in `/internal/resolve`, and that both containers are on `mcp-network` (`docker network inspect mcp-network`). |
| `400 invalid_toolsets` | Unknown name in `?toolsets=`. The error lists the valid names. |
| Fewer tools than expected | The option name is misspelled (only `toolsets` and `read_only` are recognised), or read-only mode is on. `forgejo_hello` shows what's enabled. |
| `/forgejo/health` shows another server's name | Another container uses the host port. Pick a free port (step 4a), update `MCP_HOST_PORT` in `.env` and `proxy_pass` in nginx, then redeploy. |
| Tool error "http:// is not allowed" or "private or internal address" | The saved instance URL is `http://` or resolves to a private IP. The hosted server only talks to public HTTPS instances. |
| Tool error "redirected … update it" | The instance URL redirects (http→https, www, or a sub-path). Save the final URL in the portal. |
| Tool error "missing the scope(s) …" | Create a token with that scope and update the connection. |
| Tool error "needs Forgejo 16.0 or newer" | That Actions feature isn't in the instance's version yet. |
| Container exits immediately | Check `docker compose logs`. Common causes: only one of `KEY_SERVICE_URL` / `KEY_SERVICE_TOKEN` is set, or `FORGEJO_TOOLSETS` is invalid. |
| Empty `initialize` responses in a client | Set `MCP_TRACE_HTTP=true`, restart, and check the logs. `ENABLE_MCP_DIAGNOSTICS=true` enables `/mcp-debug/open` for testing the connection itself. |

## Useful commands

```bash
cd /opt/mcp-servers/forgejo
docker compose ps
docker compose logs -f --tail=100
docker compose restart
docker compose up -d --build          # rebuild after manual changes
docker volume inspect forgejo_analytics-data
```

---

## Production record (2026-10-08)

What was actually set up for the first deploy (no secrets):

| Item | Value |
|---|---|
| mcp-forgejo | v3.0.0, merged in [#1](https://github.com/hithereiamaliff/mcp-forgejo/pull/1). Healthy about 1–2 minutes after the merge. |
| Key service | `forgejo` connector from [mcp-key-service#2](https://github.com/hithereiamaliff/mcp-key-service/pull/2). Token added to `INTERNAL_SERVER_TOKENS` (backup: `/opt/mcp-key-service/.env.backup`). |
| Host port | **8100** (`MCP_HOST_PORT=8100`). 8098 is the Singapore Open Data MCP and 8099 was also taken. Surveying the local repos had missed both, which is why step 4a finds the port on the server. |
| nginx | `location /forgejo/` inserted after `/zerobounce/` in `/etc/nginx/sites-available/mcp.techmavie.digital` (backup: `….bak-forgejo`). The existing warning "conflicting server name hithere.mynameisaliff.co.uk" is unrelated. |
| Deploy key | `github-actions-mcp-forgejo` (ed25519) in `/root/.ssh/authorized_keys`. The private key exists only in the `VPS_SSH_KEY` secret. |
| Hairpin NAT | Not needed: the container reaches `git.mynameisaliff.co.uk` directly. |
| Forgejo instance | Upgraded from 14.0.3 to 15.0.9 LTS the same day. See [docs/FORGEJO-UPGRADE.md](../docs/FORGEJO-UPGRADE.md). |
| End-to-end test | Run through Claude with a portal `usr_` key. All of these passed: <ul><li>connection, and reads across all 32 repos</li><li>multi-file commit on a new branch</li><li>PR, inline review, and squash merge guarded by the head commit</li><li>issue lifecycle</li><li>mirror sync</li><li>repo deletion with the name-confirmation safeguard</li></ul> |
