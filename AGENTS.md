# AGENTS.md

Guidance for AI coding assistants (Claude Code, Cursor, etc.) working on this repository.

## What this is

A TypeScript MCP server for Forgejo (self-hosted, Codeberg, mostly Gitea-compatible), built on the TechMavie v2 pattern (same as `mcp-zerobounce`): stateless Streamable HTTP with per-request isolation, mcp-key-service integration, plus a stdio CLI. The old Go implementation lives at tag `go-legacy-v2.17.0`.

## Commands

```bash
npm install
npm run typecheck       # tsc --noEmit
npm test                # node --import tsx --test tests/*.test.ts
npm run build           # → dist/
npm run dev             # HTTP server via tsx
npm run docs:tools      # regenerate TOOLS.md (run after changing any tool)
npm run smoke           # live check; needs FORGEJO_URL + FORGEJO_ACCESS_TOKEN in .env (SMOKE_WRITE=1 for writes)
```

## Architecture

```
src/http-server.ts ─┐                       ┌─ src/tools/<toolset>.ts  (defineTool objects)
src/cli.ts ─────────┴─ src/index.ts ────────┤
   (auth, key service,   createForgejoServer │  src/tools/shared.ts     (presets, schema factories, results)
    toolset/read-only    + ALL_TOOLS         │  src/tools/lookups.ts    (label/milestone/SHA resolution)
    per request)         + registerTools     └─ src/forgejo/client.ts   (REST client: SSRF guard, paging,
                                                                         retries, errors, version gating)
```

- `src/forgejo/`: `client.ts` (requests), `errors.ts` (actionable messages), `url.ts` (instance URL normalisation and path helpers), `ssrf.ts` (guarded DNS lookup), `capabilities.ts` (version and paging limits per instance), `projections.ts` (compact JSON shapes).
- `src/utils/`: `key-service.ts`, `analytics.ts`, `security.ts`, `format.ts` (markdown, `untrusted()`), `diff.ts`, `workflows.ts`.
- `src/config.ts`: the toolset list, default toolsets, network policy.

## Adding or changing a tool

1. Add a `defineTool({...})` to the right `src/tools/<toolset>.ts` and include it in that file's exported array. The order of the array is the listing order.
2. **Naming:** `forgejo_<verb>_<noun>`. Give it a short `title` and a description of at least 60 characters (what it does, when to use it, related tools).
3. **Annotations:** pick a preset from `shared.ts`. Use `READ_ONLY` for GETs, `WRITE` for creates, `WRITE_IDEMPOTENT` for update/set, and `DESTRUCTIVE` for deletes, merges and cancels. If you add a destructive tool, update the exact list in `tests/tools.test.ts`.
4. **Schemas:** build them only from the factory helpers (`repoRef()`, `pagination()`, `responseFormatSchema()`...), called once per use. Reusing a zod instance produces `$ref`, which strict clients reject. `.describe()` every parameter; the tests enforce both rules.
5. **Output:** read tools return `formatResult(format, markdown, json)`. JSON must be a compact projection, never a raw API object. Text written by other people (bodies, comments, files, logs) goes through `untrusted()` or a code block.
6. **Errors:** throw `ToolInputError` for bad input combinations, and let `ForgejoError` propagate. Never put the token in messages.
7. **Paths:** use `repoPath()`. Encode user-supplied segments with `encodeURIComponent`, or with `encodePath` for file paths, branches and refs. The client rejects `.`/`..` segments centrally; don't work around that.
8. **Version gating:** features that only exist in newer Forgejo releases set `minVersion: '16.0'` (or similar). Check the endpoint against a v14 swagger first.
9. Add behaviour tests (`fakeForgejo` + `connect` from `tests/helpers.ts`), then run `npm run docs:tools`.

## Rules

- Never store credentials in `process.env`, module state or logs. They exist only in the per-request closure in `createForgejoServer`.
- Don't weaken the SSRF guard (`ssrf.ts`, `url.ts`) or the redirect refusal in `client.ts`. The hosted server fetches URLs that users typed in.
- The HTTP server is stateless. Don't add sessions.
- Keep dependencies minimal. The runtime deps are the MCP SDK, express, cors, zod, undici and yaml.
- Commit style: conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `build:`).

## Deployment

The `deploy-vps.yml` workflow runs the tests on push to `main`, then deploys over SSH to `/opt/mcp-servers/forgejo` (Docker, `127.0.0.1:8099`, nginx `location /forgejo/`). See [deploy/DEPLOYMENT.md](deploy/DEPLOYMENT.md). The key-service side is the `forgejo` connector in `hithereiamaliff/mcp-key-service`.
