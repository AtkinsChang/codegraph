# codegraph telemetry ingest worker

The first-party endpoint behind `telemetry.getcodegraph.com`. This directory is in the
public repo **on purpose**: it is the exact code that receives codegraph's anonymous usage
telemetry, so anyone can audit what is stored. The schema contract (every event, every
field, and everything that is never collected) is in
[`docs/design/telemetry.md`](../docs/design/telemetry.md).

What it does, in one breath: validates incoming batches against a strict allowlist (unknown
events dropped, unknown properties stripped), never reads or stores the client IP,
rate-limits per machine ID, and writes the survivors to our own D1 database off the response
path. A nightly cron rolls each finished day up into anonymous daily counts and deletes the
raw rows behind it. It makes no outbound requests — nothing is forwarded to a third-party
analytics vendor. It ships nowhere with the npm package — the engine's `files` allowlist
excludes it.

## Endpoint contract

- `POST /v1/events` — JSON body: envelope (`machine_id` UUID, `codegraph_version`, `os`,
  `arch`, `node_major`, `ci`, `schema_version`) + `events: [{event, ts?, props?}]`.
  Responds `204` when accepted (including events dropped by the allowlist), honest `4xx`
  for malformed/oversized/rate-limited requests. Clients treat every response as final —
  no retries.
- `GET /` — plain-text pointer to the docs and the off-switches.
- `POST /admin/rollup` — manual rollup trigger, see below. `404` unless `ADMIN_TOKEN` is set.

## Storage (Cloudflare D1)

Telemetry is stored in the `codegraph-telemetry` D1 database on the same account, bound as
`env.DB` — this database is the only place accepted events go. Each request's surviving
events are written in a single `batch()` (one implicit transaction) under `ctx.waitUntil`,
so the write is off the response path. It is deliberately **fail-silent**: a D1 error is
logged to Workers Logs (counts only, never the payload) and the client still gets its `204`,
because clients never retry — losing a datapoint beats losing availability. Alongside the
raw rows, the worker upserts `machine_days` and `machine_first_seen`; when a batch is emptied
by the allowlist, nothing at all is written, so those tables only ever describe stored events.

The complete schema is [`migrations/0001_init.sql`](migrations/0001_init.sql) —
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
Workers Paid, plus roughly as much again once the purge reaches steady state — a delete bills
like an insert, and at steady state every row written is eventually deleted, so budget ≈48M.
D1 bills a row write per index touched on top of the table row, which is why `events` carries
only two indexes; dropping `events_machine_day` is the first lever if that gets tight. Storage
is the other constraint, and it is what sets the window: raw events grow ≈74 MB/day, so 90 days
lands at ≈6.7 GB against D1's 10 GB per-database cap, while 180 days would exceed it. Full
arithmetic and the remaining levers are in the migration's footer comment.

## Rollups & retention (nightly cron)

`src/rollup.ts` runs on a Cron Trigger at **00:30 UTC** and does two things.

**Rolls up** the day that just ended into `daily_machines`, `daily_event_counts` and
`daily_dim_counts`, then re-runs the two days before it — offline clients ship completed-day
rollups late, so a day keeps growing after it ends. The aggregation is one
`INSERT … SELECT … ON CONFLICT DO UPDATE` per table or dimension, so it happens inside D1 and
no event row crosses the wire. Every write overwrites the recomputed value rather than adding
to it: **re-running a day is a no-op, never a double count.** Two things the SQL is careful
about — a `usage_rollup` row is a counter the client pre-aggregated, so its `count` prop is
summed rather than the rows counted; and `index.languages` / `install.targets` are unnested
with `json_each`, one row per element. Adding a breakdown is a line in `ROLLUP_STATEMENTS`,
never a migration — that is what the generic `(dim, value)` shape buys.

**Purges** raw `events` older than `RETENTION_DAYS` (90, a var in `wrangler.jsonc`) in bounded
`DELETE` batches, and logs one line of counts. `machine_days` and `machine_first_seen` are
never purged — retention cohorts need the full history and they are two orders of magnitude
smaller. Rollups are kept forever, so shortening the window costs ad-hoc drill-back, never a
chart.

Backfill or repair without a redeploy, guarded by the `ADMIN_TOKEN` secret:

```bash
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" \
  'https://telemetry.getcodegraph.com/admin/rollup?day=2026-07-27'          # one day
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" \
  'https://telemetry.getcodegraph.com/admin/rollup?day=2026-07-27&days=14'  # the 14 days ending there
```

`&reset=1` drops the day's rollup rows before recomputing, for when the dimension list itself
changed and a value that no longer exists would otherwise linger. It is ignored past the
retention window, where it would delete rows and then find no events to rebuild them from —
the response says which days it refused. Keep manual ranges to a few days at production volume;
each day is a full scan of that day's events, and the request has a wall-clock budget.

## Deploy

Prereqs: the `getcodegraph.com` zone on the deploying Cloudflare account (the custom
domain route auto-provisions DNS + cert), wrangler ≥ 4.36 (the `ratelimits` binding).

```bash
cd telemetry-worker
npm install
npx wrangler login     # once
npm run db:migrate     # bring the D1 schema up to date FIRST — the worker writes on deploy
npm run deploy
npx wrangler secret put ADMIN_TOKEN   # optional, see below
```

The worker holds no API keys — it talks to nothing but its own bound D1 database. The one
secret is `ADMIN_TOKEN`, which enables `POST /admin/rollup`; leave it unset and that route
does not exist. Generate one with `openssl rand -hex 32`, and note that rotating it takes
effect on the next request.

## Local dev & checks

```bash
npm run check                # wrangler types + tsc --noEmit + deploy --dry-run
npm run db:migrate:local     # once, so `wrangler dev` has tables to write to
npm run dev                  # http://localhost:8787 (local D1 in .wrangler/)
npm run smoke                # end-to-end: boots `wrangler dev`, POSTs, asserts stored rows
npm run smoke:rollup         # end-to-end: seeds synthetic days, rolls them up, purges,
                             # asserts every number against hand-computed values

curl -i localhost:8787/v1/events -H 'content-type: application/json' -d '{
  "machine_id": "00000000-0000-4000-8000-000000000000",
  "codegraph_version": "0.9.9", "os": "darwin", "arch": "arm64",
  "node_major": 22, "ci": false, "schema_version": 1,
  "events": [{ "event": "usage_rollup",
               "props": { "kind": "mcp_tool", "name": "codegraph_explore",
                          "count": 12, "error_count": 0, "client_name": "Claude Code" } }]
}'

npx wrangler d1 execute codegraph-telemetry --local \
  --command "select day, event, machine_id, props from events order by id desc limit 5"
```

To drive the cron body by hand, run `wrangler dev --test-scheduled` and hit
`localhost:8787/__scheduled?cron=30+0+*+*+*`. For `POST /admin/rollup` locally, copy
`.dev.vars.example` to `.dev.vars` — without an `ADMIN_TOKEN` the route 404s, exactly as a
deploy that never set the secret does.

## Changing the schema

The allowlist in `src/index.ts` mirrors `docs/design/telemetry.md` (and the user-facing
`TELEMETRY.md`). A field is added by one PR touching all of them together — that is the
whole point of the design.
