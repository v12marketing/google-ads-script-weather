# HomeDeliveryClaims.com

The website and integration service for Home Delivery Claims: claimants file a
damaged-delivery claim, follow it on a private claim page, message the claims
team, add photos, e-sign a settlement and submit payment details. The claims team
keeps working in Monday.com; email, text messages and the settlement e-signature
go through HighLevel.

One Node 22 / TypeScript service (Fastify) does all of it:

- **Public site**: home, how it works, FAQ, privacy, terms, and `/start-a-claim`
  with the embedded Monday WorkForm.
- **Claim page** (`/c/<token>`): private link per claim, plus a one-time email
  code the first time a browser opens it. Status, messages, files, settlement and
  payment steps.
- **Webhooks** from Monday (new claims, status changes, file columns, updates)
  and HighLevel (replies, signed/declined settlements). They only validate,
  dedupe and enqueue; a durable SQLite job queue does the API work with retries.
- **Admin page** (`/admin`): edit claimant message wording, retry failed jobs,
  look up a claim, resend or replace its private link.

The Monday board is the record. SQLite (`DATA_DIR/hdc.sqlite`) is a cache for the
claim page plus the job queue; claim files are cached under `DATA_DIR/files`.
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes every flow and the rules
the code follows (what is never logged, what never goes in a text message).

## Commands

| Command | What it does |
| --- | --- |
| `npm ci` | Install dependencies (Node 22+). |
| `npm test` | Run the test suite. Uses in-memory fakes of Monday and HighLevel and an in-memory database; needs no accounts or network. |
| `npm run typecheck` | TypeScript check of `src/` and `test/`. |
| `npm run build` | Compile the service and the setup scripts to `dist/` and copy static assets. |
| `npm start` | Run the compiled server (`dist/src/server.js`). |
| `npm run dev` | Run from source with reload. Reads settings from `./.env` and the environment (see below). |
| `npm run hash-password` | Print an `ADMIN_PASSWORD_HASH` for a password (prompts, or reads stdin). |
| `npm run monday:setup -- check` | Check `config/board.json` against the live Monday boards. |
| `npm run monday:setup -- webhooks` | Register the Monday webhooks (safe to re-run; `--delete` removes them). |
| `npm run highlevel:setup -- check` | Check the HighLevel token, custom fields, settlement template and user. |
| `npm run highlevel:setup -- fields` | Create the HighLevel contact custom fields the service uses. |

In the production container there is no `tsx`; the same scripts are compiled:
`docker compose exec app node dist/scripts/monday-setup.js check` and so on.

## Running it locally

There is no offline mode for the server: `npm run dev` talks to the real Monday
and HighLevel APIs, so use a **test board and a test HighLevel sub-account**,
never production ones (every item created on the configured claims board is
treated as a new claim and emails the address on it). The fakes exist for tests
only.

1. `cp .env.example .env` and fill it in (comments in the file; details in
   [docs/SETUP.md](docs/SETUP.md)). For local work set `PUBLIC_BASE_URL=http://localhost:3000`,
   `NODE_ENV=development` and `DATA_DIR=./data`.
2. `cp config/board.example.json config/board.json` and put in the test board's ids.
3. Start it (`npm run dev` loads `./.env` when it exists):
   ```sh
   npm run dev
   ```
4. Open http://localhost:3000 and http://localhost:3000/admin.

Monday and HighLevel can only deliver webhooks to a public HTTPS URL. To try
the full flow locally, expose port 3000 with a tunnel (for example
`cloudflared tunnel --url http://localhost:3000`), set `PUBLIC_BASE_URL` to the
tunnel's address and run `npm run monday:setup -- webhooks`.

## Project layout

```
src/
  server.ts            process entry: config, real API clients, worker, HTTP server
  config.ts            environment variables (validated with zod)
  board-config.ts      config/board.json: Monday board, column ids, status labels
  context.ts           wires the services together
  db/                  SQLite schema/migrations (index.ts) and all SQL (repo.ts)
  domain/types.ts      Claim, messages, files, templates, status keys
  adapters/monday/     Monday GraphQL client, webhook parsing, test fake
  adapters/highlevel/  HighLevel client, webhook parsing/signature, test fake
  services/            one module per concern (intake, status, settlement,
                       payment, messaging, files, auth, notifier, templates,
                       tokens), job handlers and the job queue
  web/                 Fastify app, routes (public, portal, webhooks, admin),
                       page content, layout, static CSS/JS
scripts/               setup helpers (Monday, HighLevel, admin password)
config/                board.example.json (copy to board.json)
deploy/                Dockerfile, docker-compose.yml, Caddyfile
docs/                  ARCHITECTURE.md, SETUP.md (go-live runbook), research notes
test/                  vitest suites; helpers.ts builds a full app on fakes
```

## Deploying

Production runs with Docker Compose on one server: the app plus Caddy for HTTPS.
[docs/SETUP.md](docs/SETUP.md) is the step-by-step runbook: server, DNS, `.env`,
Monday boards and forms, HighLevel, SMS registration, launch checklist,
backups and updates.

## Security notes

- Claim links are derived (HMAC of the item id and a version), never stored;
  only their SHA-256 is. Replacing a link from `/admin` revokes the old one and
  every trusted browser.
- Bank details go from the claimant's browser straight to a private Monday
  board; this service never receives them.
- Never log or paste into tickets: portal links, login codes, `.env` values, the
  webhook URL (it contains `WEBHOOK_SECRET`), Monday file URLs.
