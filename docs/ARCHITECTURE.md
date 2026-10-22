# HomeDeliveryClaims — architecture

One Node 22 / TypeScript service (Fastify) serves the public site, the claimant
portal, the admin page and the webhook endpoints, and runs the background job
worker. SQLite (better-sqlite3) holds the portal cache; files are cached on disk.
The Monday board is the record. Deployed with Docker Compose behind Caddy.

## Flows

**New claim.** The claimant fills in the Monday WorkForm embedded on
`/start-a-claim`. Monday creates an item and fires `create_item` →
`POST /webhooks/monday/<secret>` → job `monday.item_created` → `intake`:
allocate `HDC-000123` (SQLite sequence, idempotent per item; an item that already
carries a number no other claim has, e.g. after a restore, keeps it), write the
claim number, date received (New York date) and portal link back to the item,
upsert the HighLevel contact, send the confirmation email (+ SMS if opted in).
Intake is resumable: a status or file event on an item whose intake didn't finish
completes it. Any item created on
the claims board is treated as a claim (form, manual, import). Files in the form's
photo column may arrive after `create_item`, so intake schedules delayed file syncs.

**Status change.** `change_status_column_value` → job → `status`: map the label to
a `StatusKey` via `config/board.json`; unknown labels are internal (no message).
The board's current label is read first: an event that no longer matches it (a
late retry or redelivery) is stale and does nothing. Otherwise send the template
for that status. `settlement_offered` also starts the settlement.

**Contact identity.** HighLevel sends to a contact's own email/phone and its
upsert matches on email OR phone. So a claim's messages only go through a
contact whose email is the claim's (texts: whose phone is), re-read from
HighLevel before every send, and an upsert never rewrites the email of another
claim's contact (the phone is left off instead, and texts are off for that
claim). When no such contact can be had, nothing is sent and the team is told.
An email or phone edit on the board (subscribed column) refreshes the claim and
re-syncs the contact; an email change also forgets the claim's trusted browsers.

**Settlement.** `settlement` writes `claim_number` / `settlement_amount` to the
HighLevel contact's custom fields, sends the Documents & Contracts template
(`POST /proposals/templates/send`) and stores both returned ids and the amount
sent. A HighLevel workflow (trigger: Documents & Contracts, Status = Completed,
Template = Settlement; action: Webhook) calls `POST /webhooks/highlevel/<secret>`.
We never trust that call alone: `verifySignedDocument` checks status, expiry and
every signer's `hasCompleted` + `signedDate` via `GET /proposals/document`. When
verified: record it, set the board to the settlement-signed label, post an update.
A send whose response was lost is looked up in HighLevel before sending again; a
document that leaves HighLevel's list (declined, deleted) is given up on after a
day with a note to the team. The claimant's signing link (`shareLink`) is shown
on the claim page once HighLevel lists it.
The signed PDF is **not available via HighLevel's API**: the update asks the team
to download it from HighLevel and attach it to the signed-settlement column (which
is claimant-visible, so it then appears on the claim page). A poller re-checks
unsigned settlements every 15 minutes in case a webhook was missed. Never two open
settlements per HighLevel contact at once (contact fields are shared).

**Payment details.** After signing, the claim page links to the payment WorkForm
on the private finance board, pre-filled (`?<lookup>=value`) with the claim number
and an HMAC of it and the claim's link version (so **Replace the claim link** also
retires it). Bank details go straight from the claimant's browser to Monday;
this service never receives them. If `paymentBoard` is configured, the service
reads only the claim-number and signature columns of new payment items (looking
again over a few minutes while they are empty), labels the item Verified / Check
claim number / Duplicate submission, and marks the claim's payment step done.
Finance pays through the bank and sets the claim to "Payment sent" → final message.

**Messages.** A Monday update starting with `To claimant:` (not authored by the
integration user) → stored as a message, emailed (+ SMS) to the claimant with the
text and the portal link. Claimant writes on the portal → stored at once, then a
job posts it as an update (`From claimant (portal): …`) and notifies
`notifyUserIds`. Email/SMS replies arrive from a HighLevel workflow (trigger:
Customer Replied; action: Webhook) or a marketplace `InboundMessage` webhook →
posted to the item the same way: the claim whose number (`HDC-…`) the subject or
text names, else the contact's newest open claim (the team is told about the
others). An SMS that is just `STATUS` gets an automatic reply per open claim
instead. `STOP` marks the claim opted out of SMS. Updates without the prefix are
internal: never sent, and never stored (not even in the job queue).

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
expiry, 5 attempts; 3 per browser per 15 min and 20 per claim per day). The code
only works in the browser that asked for it, so its email carries no claim link.
Success sets a long-lived httpOnly device cookie trusted for that claim. `/find-my-claim` emails links for an address
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
- Jobs must be idempotent: they can run more than once. Monday writes made once
  per key (`onceFor`) carry a matching Idempotency-Key, so a retry after a lost
  response doesn't post twice. Monday's daily-limit errors park a job until the
  reset instead of using up its attempts. On shutdown the worker finishes the
  job it is running. Done jobs are deleted after 7 days.
- Never log or store bank details, `public_url`s, portal tokens or login codes.
- Claim amounts don't go in SMS. Settlement amounts appear on the claim page and
  the settlement document, not in email or SMS.
