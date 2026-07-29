# codegraph telemetry ingest worker

The first-party endpoint behind `telemetry.getcodegraph.com`. This directory is in the
public repo **on purpose**: it is the exact code that receives codegraph's anonymous usage
telemetry, so anyone can audit what is stored. The schema contract (every event, every
field, and everything that is never collected) is in
[`docs/design/telemetry.md`](../docs/design/telemetry.md).

What it does, in one breath: validates incoming batches against a strict allowlist (unknown
events dropped, unknown properties stripped), never reads or forwards the client IP,
rate-limits per machine ID, and forwards to PostHog off the response path. It ships nowhere
with the npm package — the engine's `files` allowlist excludes it.

## Endpoint contract

- `POST /v1/events` — JSON body: envelope (`machine_id` UUID, `codegraph_version`, `os`,
  `arch`, `node_major`, `ci`, `schema_version`) + `events: [{event, ts?, props?}]`.
  Responds `204` when accepted (including events dropped by the allowlist), honest `4xx`
  for malformed/oversized/rate-limited requests. Clients treat every response as final —
  no retries.
- `GET /` — plain-text pointer to the docs and the off-switches.

## Storage (Cloudflare D1)

Telemetry is stored in the `codegraph-telemetry` D1 database on the same account, bound as
`env.DB`. The complete schema is [`migrations/0001_init.sql`](migrations/0001_init.sql) —
checked in for the same reason this worker's source is public: it is the entire list of what
gets kept, with a comment on every column and on which dashboard chart each rollup table
serves. Shape: raw sanitized `events`, `daily_*` rollups recomputed nightly, and
`machine_days` / `machine_first_seen` for retention cohorts. The dashboard reads rollups; raw
events exist for drill-down and are purged past the retention window.

```bash
npm run db:migrate:local     # apply to the local .wrangler state (offline, no account needed)
npm run db:migrate           # apply to the remote codegraph-telemetry database
npm run db:migrations        # which migrations are applied remotely
npm run db:sql "select count(*) from events"
```

Both applies bootstrap from empty and are a no-op when already current. A schema change is a
new numbered file (`npx wrangler d1 migrations create codegraph-telemetry <name>`) — never an
edit to a migration that has been applied.

Volume, at ~97k accepted POSTs/day: ≈30M D1 row writes/month against the 50M included on
Workers Paid. D1 bills a row write per index touched on top of the table row, which is why
`events` carries only two indexes. Storage is the tighter constraint — raw events grow
≈74 MB/day, so a 90-day retention window lands at ≈6.7 GB against D1's 10 GB per-database
cap, while 180 days would exceed it. Rollups are tiny and kept forever, so shortening the raw
window costs drill-back, never a chart. Full arithmetic and the levers are in the migration's
footer comment.

## Deploy

Prereqs: the `getcodegraph.com` zone on the deploying Cloudflare account (the custom
domain route auto-provisions DNS + cert), wrangler ≥ 4.36 (the `ratelimits` binding).

```bash
cd telemetry-worker
npm install
npx wrangler login                      # once
npx wrangler secret put POSTHOG_KEY     # the phc_… project write key — never committed
npm run db:migrate                      # bring the D1 schema up to date first
npm run deploy
```

The PostHog project itself must have **"Discard client IP data"** enabled — defense in
depth on top of this worker never forwarding IPs (`$geoip_disable` is also set per event).

## Local dev & checks

```bash
cp .dev.vars.example .dev.vars   # placeholder key; also feeds `wrangler types`
npm run check                    # wrangler types + tsc --noEmit + deploy --dry-run
npm run dev                      # http://localhost:8787

curl -i localhost:8787/v1/events -H 'content-type: application/json' -d '{
  "machine_id": "00000000-0000-4000-8000-000000000000",
  "codegraph_version": "0.9.9", "os": "darwin", "arch": "arm64",
  "node_major": 22, "ci": false, "schema_version": 1,
  "events": [{ "event": "usage_rollup",
               "props": { "kind": "mcp_tool", "name": "codegraph_explore",
                          "count": 12, "error_count": 0, "client_name": "Claude Code" } }]
}'
```

## Changing the schema

The allowlist in `src/index.ts` mirrors `docs/design/telemetry.md` (and the user-facing
`TELEMETRY.md`). A field is added by one PR touching all of them together — that is the
whole point of the design.
