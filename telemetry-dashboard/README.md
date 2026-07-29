# codegraph telemetry dashboard

The private admin view behind `stats.getcodegraph.com`. Its sibling
[`telemetry-worker/`](../telemetry-worker/) writes anonymous usage events into a D1 database;
this worker reads them back and draws the charts. Two people use it, so the auth is
deliberately the simplest thing that is actually safe: one shared password in a secret, and
a long-lived signed cookie.

This directory is in the public repo for the same reason the ingest worker is — the code
that touches telemetry should be readable by the people it collects from. Nothing secret
lives here: the password and the cookie-signing key are deployment secrets, and the D1
database ID is an identifier, not a credential.

## What is gated

Everything except the login page and `robots.txt`. `assets.run_worker_first` is `true` in
`wrangler.jsonc`, so Cloudflare hands *every* request to `src/index.ts` before the static
asset server sees it — the dashboard HTML, its JS, its CSS and the chart library are all
behind the session check, and a request without a valid cookie gets a redirect (pages) or a
`401` (`/api/*`). The login page is rendered inline by the worker rather than served from
`public/`, so the asset directory needs no "is this file public?" judgement calls.

| Route | Auth | Notes |
|---|---|---|
| `GET /login` | public | Password form. Redirects to `/` if already signed in. |
| `POST /login` | public | Rate-limited per IP; sets the session cookie on success. |
| `POST /logout` | public | Clears the cookie. |
| `GET /robots.txt` | public | `Disallow: /`. |
| `GET /api/*` | required | JSON. `401` without a session. CG-12 adds the chart endpoints. |
| everything else | required | Static assets from `public/`. `302 /login` without a session. |

## How the session works

- The password is compared in constant time, over SHA-256 digests so the operands are always
  the same length and nothing about the secret leaks through timing.
- The cookie is a signed assertion — `base64url(payload).base64url(HMAC-SHA256)` — not a
  lookup key. There is no session store; a tampered payload fails the signature check.
- `HttpOnly; Secure; SameSite=Lax; Path=/`, `Max-Age` one year. You sign in once per browser
  and it survives restarts.
- The payload carries a fingerprint of the password it was minted against, so
  **rotating `ADMIN_PASSWORD` signs everyone out** — that is the revocation story.
- Login attempts are capped at 5/min per IP. Unlike the ingest worker, which never reads the
  client IP at all, this one does — solely as a rate-limit key, never stored or logged.

## Deploy

Prereqs: the `getcodegraph.com` zone on the deploying Cloudflare account (the custom domain
auto-provisions DNS + cert), and the D1 database from `telemetry-worker/` already created.

```bash
cd telemetry-dashboard
npm install
npx wrangler login                      # once

npx wrangler secret put ADMIN_PASSWORD  # the shared password
npx wrangler secret put SESSION_SECRET  # cookie-signing key, e.g. `openssl rand -base64 48`

npm run deploy
```

Both secrets are required — the worker refuses every request if either is missing, so a
half-configured deployment fails closed rather than becoming an open dashboard.

Rotating either one is a `wrangler secret put` away. Rotating `SESSION_SECRET` invalidates
outstanding cookies too, and is the right move if you think one leaked.

Migrations belong to the writer, not to this worker: apply schema changes from
`telemetry-worker/` (`npm run db:migrate`). D1 is read-only here.

## Local dev & checks

```bash
cp .dev.vars.example .dev.vars   # placeholder secrets; also feeds `wrangler types`
npm run check                    # vendor + wrangler types + tsc --noEmit + deploy --dry-run
npm run dev                      # http://localhost:8787

./scripts/smoke-auth.sh          # end-to-end auth suite against a throwaway `wrangler dev`
```

`smoke-auth.sh` is the regression net for the gate: it asserts that unauthenticated requests
reach nothing (pages, API *and* static assets), that the cookie is persistent and correctly
flagged, that flipped/truncated/forged cookies are all rejected, that brute force is capped,
and that rotating the password invalidates existing sessions. Run it after touching
`src/auth.ts` or the route table in `src/index.ts`. It needs a local D1 to answer
`/api/health`, which it seeds itself from the ingest worker's migration.

## Frontend

Plain static files in `public/` — one HTML page, ES modules, no framework, no build step.
Workers Static Assets serves them verbatim, so third-party libraries are copied out of
`node_modules` into `public/vendor/` by `npm run vendor` (wired into `dev` and `deploy`).
That keeps the version pinned by the lockfile, avoids a third-party origin at runtime, and
lets the CSP stay `script-src 'self'`. `public/vendor/` is gitignored — it is build output.

Visual conventions follow the rest of codegraph: flat and editorial, square corners, hairline
rules, sentence-case headings, one oxblood accent, no tiny all-caps tracked labels.
