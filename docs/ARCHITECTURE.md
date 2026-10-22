# HomeDeliveryClaims — architecture

One Node 22 / TypeScript service (Fastify) serves the public site, the claimant
portal, the admin page and the webhook endpoints, and runs the background job
worker. SQLite (better-sqlite3) holds the portal cache; files are cached on disk.
The Monday board is the record. Deployed with Docker Compose behind Caddy.

## Flows

**New claim.** The claimant fills in the Monday WorkForm embedded on
`/start-a-claim`. Monday creates an item and fires `create_item` →
`POST /webhooks/monday/<secret>` → job `monday.item_created` → `intake`:
allocate `HDC-000123` (SQLite sequence, idempotent per item), write the claim
number, date received and portal link back to the item, upsert the HighLevel
contact, send the confirmation email (+ SMS if opted in). Any item created on
the claims board is treated as a claim (form, manual, import). Files in the form's
photo column may arrive after `create_item`, so intake schedules delayed file syncs.

**Status change.** `change_status_column_value` → job → `status`: map the label to
a `StatusKey` via `config/board.json`; unknown labels are internal (no message).
Send the template for that status. `settlement_offered` also starts the settlement.

**Settlement.** `settlement` writes `claim_number` / `settlement_amount` to the
HighLevel contact's custom fields, sends the Documents & Contracts template
(`POST /proposals/templates/send`) and stores both returned ids and the amount
sent. A HighLevel workflow (trigger: Documents & Contracts, Status = Completed,
Template = Settlement; action: Webhook) calls `POST /webhooks/highlevel/<secret>`.
We never trust that call alone: `verifySignedDocument` checks status, expiry and
every signer's `hasCompleted` + `signedDate` via `GET /proposals/document`. When
verified: record it, set the board to the settlement-signed label, post an update.
The signed PDF is **not available via HighLevel's API**: the update asks the team
to download it from HighLevel and attach it to the signed-settlement column (which
is claimant-visible, so it then appears on the claim page). A poller re-checks
unsigned settlements every 15 minutes in case a webhook was missed. Never two open
settlements per HighLevel contact at once (contact fields are shared).

**Payment details.** After signing, the claim page links to the payment WorkForm
on the private finance board, pre-filled (`?<lookup>=value`) with the claim number
and an HMAC of it. Bank details go straight from the claimant's browser to Monday;
this service never receives them. If `paymentBoard` is configured, the service
reads only the claim-number and signature columns of new payment items, labels
the item Verified / Check claim number, and marks the claim's payment step done.
Finance pays through the bank and sets the claim to "Payment sent" → final message.

**Messages.** A Monday update starting with `To claimant:` (not authored by the
integration user) → stored as a message, emailed (+ SMS) to the claimant with the
text and the portal link. Claimant writes on the portal → stored at once, then a
job posts it as an update (`From claimant (portal): …`) and notifies
`notifyUserIds`. Email/SMS replies arrive from a HighLevel workflow (trigger:
Customer Replied; action: Webhook) or a marketplace `InboundMessage` webhook →
posted to the item the same way. An SMS that is just `STATUS` gets an automatic
reply with the current status instead. `STOP` marks the claim opted out of SMS.

**Files.** File columns listed in `sharedFileColumns`, plus the signed-settlement,
intake-photo and claimant-upload columns, are mirrored into the cache on
`change_column_value` events (download server-side; Monday's `public_url` is
never exposed). Every other file column is internal and never read. Claimant
uploads on the portal are stored at once and attached to the claimant-uploads
column by a job.

**Portal access.** Links are `/c/<token>` where token =
HMAC(APP_SECRET, `portal:<itemId>:<tokenVersion>`), so every email can include
it without storing it; only its SHA-256 is stored, for lookup. The first visit
from a browser asks for a 6-digit code emailed to the claim's address (10 min
expiry, 5 attempts, rate-limited); success sets a long-lived httpOnly device
cookie trusted for that claim. `/find-my-claim` emails links for an address
without revealing whether it is known.

## Code layout

- `src/config.ts`, `src/board-config.ts` — environment and board mapping.
- `src/db/` — schema/migrations and `Repo` (all SQL).
- `src/adapters/monday|highlevel/` — `types.ts` (interfaces), `client.ts` (real
  API), `fake.ts` (tests), `webhook.ts` (payload parsing/verification).
- `src/services/` — one module per concern, wired in `src/context.ts`; job
  handlers in `handlers.ts`; the durable queue in `jobs.ts`.
- `src/web/` — Fastify app, routes, layout, static assets.

## Rules

- Webhook handlers only validate, dedupe and enqueue, then return 200. All API
  work happens in jobs (retry with backoff, dead-letter visible in /admin).
- Jobs must be idempotent: they can run more than once.
- Never log or store bank details, `public_url`s, portal tokens or login codes.
- Claim amounts don't go in SMS. Settlement amounts appear on the claim page and
  the settlement document, not in email or SMS.
