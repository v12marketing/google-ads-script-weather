# Monday.com GraphQL API and webhooks for the HomeDeliveryClaims.com integration service (Node/TypeScript). Verified 2026-10-22 against WebSearch extracts of developer.monday.com and support.monday.com, monday's official SDL (mondaycom/mcp master, fetched from api.monday.com/v2/get_schema), and the npm packages @mondaydotcomorg/api 14.3.1 and @mondaydotcomorg/agent-toolkit 5.77.0, both inspected directly.

## 1. Endpoint, auth header, API-Version header and current stable version string

_Confidence: high_

VERIFIED, with corrections and additions.

ENDPOINTS (confirmed)
- GraphQL: POST https://api.monday.com/v2 with JSON body {query, variables}.
- File uploads: POST https://api.monday.com/v2/file as multipart/form-data (finding 5).
- Schema SDL: GET https://api.monday.com/v2/get_schema?format=sdl&version=YYYY-MM. monday's own fetch-schema.sh uses this URL.

AUTH (confirmed)
- Header: `Authorization: <token>`. No 'Bearer' prefix is needed.
- A token has exactly the UI permissions of its owner. Regenerating a token invalidates the old one.
- Where to find the token:
  - Admins: profile picture > Administration > Connections > Personal API token.
  - All users: profile menu > Developers > "My access tokens" (or "API token") > Show. The label varies by UI version.
- ADDED: only admins and members can use the API. Guests cannot get a token. Viewers, deactivated or disabled users, and users with an unconfirmed email cannot access the API.
  - So the dedicated "HDC Integration" user must be a full Member seat, which is a paid seat.
- ADDED (unverified alternative): the latest official SDL has service users:
  - mutations: create_service_user(name, title), regenerate_service_user_token(service_user_id), revoke_service_user_tokens
  - queries: service_users, service_user_tokens
  - These are non-human accounts with their own API tokens, which would suit echo-suppression better than a human seat.
  - However, this SDL is the 2027-01 RC schema (version.utils.ts says '2027-01'). The fields are absent from the @mondaydotcomorg/api 14.3.1 typings, and I found no docs or release note for them.
  - Do not depend on them for 2026-10 until you confirm with get_schema?version=2026-10 and with monday.
- OAuth app token: the other option. It is required for JWT-signed webhooks (finding 2c).

API-VERSION (confirmed)
- Header: `API-Version: YYYY-MM` with month 01, 04, 07 or 10.
- If you omit it, you get the version that is Current that day, so always pin it.
- Lifecycle: RC, then Current, then Maintenance, then Deprecated. monday does not reject a deprecated version; it answers with the Maintenance version.

CURRENT VERSION AS OF 2026-10-22: `2026-10`. Confidence raised to high.
- The official versioning table gives 2026-10: RC 2026-07-01, Current 2026-10-01, Maintenance 2027-01-15.
- 2027-01 has been the RC since 2026-10-01 and becomes Current on 2027-01-15. CORRECTION: the date is the 15th, not the 1st.
- The versioning page's banner still calls 2026-10 an RC. That banner is stale.
- agent-toolkit 5.77.0 (npm, 2026-10-20) hard-codes "2026-10". I confirmed this in the bundle.
- @mondaydotcomorg/api 14.3.1 has DEFAULT_VERSION = CURRENT_VERSION = "2026-01" (confirmed in dist/esm/lib/constants/index.d.ts). Always pass apiVersion.

ADDED: 2026-10 BREAKING CHANGES
- The User entity migration completes in this version.
- Removed User fields: photo_original, photo_thumb (and the other photo_* fields), is_guest, is_admin, is_pending, enabled, join_date, sign_up_product_kind.
- Do not select these in `me { ... }`. `me { id name email }` is fine.
- 2026-07 had already changed the `users` query default to 200 users.
- None of the 2026-10 notes I found touch webhooks, updates, assets or column_values.

Boot check (fields confirmed in SDL: Version {value kind display_name}; VersionKind enum as listed):
```graphql
query { version { value kind } versions { value kind display_name } }
```

CODE: unchanged and correct. SDK: `new ApiClient({ token, apiVersion, endpoint?, requestConfig? })`. `client.request(query, vars, { idempotencyKey, timeoutMs, versionOverride, headers })` is confirmed in api-client.d.ts.

Sources:
- https://developer.monday.com/api-reference/docs/api-versioning (WebSearch extract: 2026-10 Current 2026-10-01, Maintenance 2027-01-15; 2027-01 RC 2026-10-01, Current 2027-01-15)
- https://developer.monday.com/api-reference/docs/release-notes (WebSearch extract: 2026-10 User field removals; 2027-01 RC)
- https://developer.monday.com/api-reference/docs/authentication
- https://developer.monday.com/api-reference/docs/mcp-api-token
- https://github.com/PostHog/posthog/pull/113223 (deprecated versions served by maintenance)
- https://registry.npmjs.org/@mondaydotcomorg/api/-/api-14.3.1.tgz (inspected: CURRENT_VERSION 2026-01, RequestOptions incl. idempotencyKey)
- https://registry.npmjs.org/@mondaydotcomorg/agent-toolkit/-/agent-toolkit-5.77.0.tgz (inspected: "2026-10")
- https://raw.githubusercontent.com/mondaycom/mcp/master/packages/agent-toolkit/src/utils/version.utils.ts (API_VERSION = '2027-01')
- https://raw.githubusercontent.com/mondaycom/mcp/master/packages/agent-toolkit/src/monday-graphql/schema.graphql (service user mutations/queries)

## 2a. Webhooks: create_webhook mutation signature, event types, config, list/delete, constraints

_Confidence: high_

SIGNATURES AND ENUM: CONFIRMED VERBATIM in the official SDL
```graphql
create_webhook(board_id: ID!, url: String!, event: WebhookEventType!, config: JSON): Webhook
delete_webhook(id: ID!): Webhook
webhooks(board_id: ID!, app_webhooks_only: Boolean): [Webhook]
type Webhook { id: ID!  board_id: ID!  event: WebhookEventType!  config: String }   # NOTE: no `url` field
```
The WebhookEventType list is correct (21 values, as given).

CORRECTIONS AND ADDITIONS
1. `Webhook` has NO `url` field. A personal-token `webhooks(board_id)` query lists every webhook on the board, including ones created by other people, by Integration-center recipes and by other tools. You cannot tell which are yours by URL.
   - The original reconcile (skip if any webhook with the same `event` exists) can therefore wrongly skip creating yours.
   - Fix: persist the ids that create_webhook returns and reconcile against them.
   - With an app token you can use `app_webhooks_only: true` instead.
2. The original code registered ONE url for all events, but the handler in 2c routes on `/:kind`. Register a per-kind URL.
3. change_status_column_value config:
   - The ONLY official example is `{"columnId":"status","columnValue":{"$any$":true}}`. Use that form.
   - The bare `{"columnId":"status"}` appears only in third-party guides (Hookdeck).
   - Firing on one label only: `{"columnId":"status","columnValue":{"index":N}}`. This comes from a monday staff forum answer, not the docs. N is the label id (see 3a).
4. url max 255 characters: only third-party sources (Hookdeck setup.md) state this; I could not confirm it in the official docs. Keep URLs short anyway.
5. The challenge handshake must succeed or creation fails. Confirmed.
6. Scopes for OAuth apps: `webhooks:write` to create or delete, and `webhooks:read` to query `webhooks`. ADDED: the read scope.
7. Subitems:
   - Use the parent board id. Confirmed.
   - InvalidArgumentException for a non-existent board id or a subitems-board id is in the 2025-04 migration guide. A hotfix changelog says it applies from 2024-10 on.
   - change_specific_column_value does not support subitem columns. Subitem status-specific webhooks are not supported.
8. `config`: pass JSON.stringify(obj) as the JSON variable. This is confirmed in practice (Pipedream; the official example passes an escaped string).
9. Avoid also subscribing to change_column_value. The advice is valid: it duplicates the status and file events.

CORRECTED RECONCILE CODE
```ts
const CREATE_WEBHOOK = `mutation ($boardId: ID!, $url: String!, $event: WebhookEventType!, $config: JSON) {
  create_webhook(board_id: $boardId, url: $url, event: $event, config: $config) { id board_id event config } }`;
const LIST_WEBHOOKS = `query ($boardId: ID!) { webhooks(board_id: $boardId) { id event config board_id } }`;
const DELETE_WEBHOOK = `mutation ($id: ID!) { delete_webhook(id: $id) { id } }`;

const KINDS: Record<string, { event: string; config?: object }> = {
  create_item: { event: 'create_item' },
  status:      { event: 'change_status_column_value', config: { columnId: STATUS_COL, columnValue: { $any$: true } } },
  files:       { event: 'change_specific_column_value', config: { columnId: SHARED_FILES_COL } },
  update:      { event: 'create_update' },
  edit_update: { event: 'edit_update' },
};
export async function ensureWebhooks(boardId: string, baseUrl: string /* https://x/hooks/monday/<secret> */) {
  const { webhooks } = await gql<{ webhooks: { id: string }[] }>(LIST_WEBHOOKS, { boardId });
  const live = new Set(webhooks.map(w => String(w.id)));
  for (const [kind, spec] of Object.entries(KINDS)) {
    const saved = await db.mondayWebhooks.get(boardId, kind);        // { id, url }
    const url = `${baseUrl}/${kind}`;
    if (saved && live.has(String(saved.id)) && saved.url === url) continue;
    if (saved && live.has(String(saved.id))) await gql(DELETE_WEBHOOK, { id: saved.id });   // URL/secret rotated
    const { create_webhook } = await gql(CREATE_WEBHOOK, { boardId, url, event: spec.event,
      config: spec.config ? JSON.stringify(spec.config) : undefined });
    await db.mondayWebhooks.put(boardId, kind, { id: create_webhook.id, url });
  }
}
```
The endpoint must already answer the challenge before ensureWebhooks runs.

Sources:
- https://raw.githubusercontent.com/mondaycom/mcp/master/packages/agent-toolkit/src/monday-graphql/schema.graphql (create_webhook, webhooks, type Webhook without url, enum WebhookEventType)
- https://developer.monday.com/api-reference/reference/webhooks (WebSearch extract: $any$ example, subitem parent board, change_specific_column_value no subitem columns, scopes)
- https://developer.monday.com/api-reference/docs/migrating-to-version-2025-04
- https://developer.monday.com/api-reference/changelog/hotfix-updated-create_webhook-errors
- https://community.monday.com/t/how-to-create-webhook-for-event-change-status-column-value-using-python/70031 (index form, staff answer)
- https://community.monday.com/t/released-new-webhook-types-for-sub-item-events/23271
- https://raw.githubusercontent.com/hookdeck/webhook-skills/main/skills/monday-webhooks/references/setup.md (third-party: 255-char url)

## 2b. Webhook payload shapes (create_item, change_status/specific/column_value, create_update, edit_update) and the challenge handshake

_Confidence: medium_

LARGELY CONFIRMED. Minor corrections.

CHALLENGE (confirmed)
- monday POSTs `{"challenge":"..."}`. Reply HTTP 200 with the same JSON.
- The challenge may arrive without an Authorization header, so handle it before any JWT check.

ENVELOPE
- Real deliveries are `{"event":{...}}`.
- The `type` field inside the event differs from the subscription name. Confirmed from third-party captured payloads (rudderlabs test fixtures) and consistent with monday's samples:
  - create_item delivers "create_pulse"
  - column changes deliver "update_column_value"
  - change_name delivers "update_name" (with previousValue {name})
  - item_archived delivers "archive_pulse"
  - item_deleted delivers "delete_pulse"
- Route by the per-kind URL, not by `type`.
- IDs arrive as JSON numbers; normalise with String().

create_item
- The sample shape is correct.
- CORRECTION/NUANCE: `columnValues` is `{}` in the published samples, but Hookdeck describes it as a snapshot of column data on create events. It may be populated, for example for form-created items.
- Either way, re-query the item; this advice is unchanged.

update_column_value
- The sample shape is correct: columnId, columnType ("color" for status), value.label.{index,text,style,is_done}, previousValue, changedAt (epoch seconds float).
- previousValue is null in the samples; code it defensively.
- No official sample exists for file columns. Re-query via the API (the monday-guided approach is to read FileValue.files / assets).

create_update
- Fields confirmed from monday's support-page sample: body, textBody, updateId, replyId.
- CORRECTION: in the official sample `body` is HTML (`"<p>create_update webhook</p>"`), not plain text. textBody is plain.
- Whether create_update fires for REPLIES, and how replyId is populated: still unconfirmed. A community thread says replies are treated as updates linked to a parent, but no source confirms the payload. Test it.

edit_update: no official sample, as stated. Always re-query `updates(ids:[updateId])`.

The TYPES interface is fine. Make parentItemId/parentItemBoardId `string | number`; samples vary.

Sources:
- https://developer.monday.com/api-reference/reference/webhooks
- https://support.monday.com/hc/en-us/articles/360003540679-Webhook-integration (create_update sample with <p> body, replyId null)
- https://raw.githubusercontent.com/rudderlabs/rudder-transformer/develop/test/integrations/sources/monday/data.ts (inspected: create_pulse, update_column_value, update_name, archive_pulse, delete_pulse)
- https://raw.githubusercontent.com/hookdeck/webhook-skills/main/skills/monday-webhooks/references/overview.md (third-party)
- https://developer-community.monday.com/api-apps-framework-4/does-when-an-update-is-created-trigger-works-for-replies-3906

## 2c. Are webhooks signed? How to authenticate deliveries; retry behaviour; handler code

_Confidence: medium_

CORE CLAIMS CONFIRMED. The handler code has bugs; corrected below.

SIGNING (confirmed)
- Official docs: "Webhooks created with personal API tokens or via the UI do not include authentication headers."
- Only webhooks created with an integration app's OAuth token carry a JWT in `Authorization`, verified with the app's Signing Secret. To get one: create an app, add an integration feature, generate an OAuth token, then call create_webhook with it.
- End users cannot turn off such webhooks (confirmed).
- The JWT does not hash the body; there is no HMAC.
- Claims are accountId, userId, aud, exp, iat, plus shortLivedToken (the claim list and HS256 come from third-party sources and match monday's integration-authorization docs).
- App lifecycle webhooks use the Client Secret.

RETRIES (confirmed official): once a minute for 30 minutes if the endpoint does not return 200. The 30 s × 10 figure is from a community report only. No delivery timeout or ordering guarantee is documented.

BUGS IN THE ORIGINAL HANDLER
1. JWT check is skippable. `if (SIGNING_SECRET && auth)` means an attacker simply omits the header. If you use app-token webhooks, REQUIRE the header and return 401 when it is missing.
2. Wrong audience. `aud` is the endpoint URL the webhook was registered with. With per-kind paths, every webhook has a different URL, so a single MONDAY_HOOK_URL env var fails verification. Compute it per request from your public base URL plus req.originalUrl. Exact `aud` formatting is from third-party docs; verify with a real delivery, or drop the audience check.
3. Ack before durable enqueue. Acking 200 and then awaiting the dedupe store and the queue loses events if the process dies, and monday will not retry after a 200. Enqueue durably first (fast) and then ack. Use the queue's job id as the dedupe key.
4. Compare the path secret with crypto.timingSafeEqual.

CORRECTED HANDLER
```ts
import express from 'express';
import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'node:crypto';
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const REQUIRE_JWT = process.env.MONDAY_WEBHOOKS_VIA_APP === 'true';   // true only if created with an app OAuth token

app.post('/hooks/monday/:secret/:kind', express.json({ limit: '1mb' }), async (req, res) => {
  if (!eq(req.params.secret, process.env.MONDAY_HOOK_PATH_SECRET!)) return res.sendStatus(404);
  if (typeof req.body?.challenge === 'string') return res.status(200).json({ challenge: req.body.challenge });
  if (REQUIRE_JWT) {
    const auth = req.header('authorization');
    if (!auth) return res.sendStatus(401);
    try {
      jwt.verify(auth.replace(/^Bearer\s+/i, ''), process.env.MONDAY_SIGNING_SECRET!, {
        algorithms: ['HS256'], clockTolerance: 30,
        audience: `${process.env.PUBLIC_BASE_URL}${req.originalUrl}` });   // verify aud format empirically
    } catch { return res.sendStatus(401); }
  }
  const ev = req.body?.event;
  if (!ev?.triggerUuid) return res.sendStatus(200);
  try {
    await queue.add(req.params.kind, ev, { jobId: `mon:${ev.triggerUuid}` });  // durable + idempotent (e.g. BullMQ)
  } catch { return res.sendStatus(500); }                                      // let monday retry
  res.sendStatus(200);
});
// In the worker: skip if String(ev.userId) === INTEGRATION_USER_ID; then re-fetch from the API before acting.
```

Sources:
- https://developer.monday.com/api-reference/docs/webhooks (WebSearch extract: personal/UI webhooks have no auth headers; users cannot turn off integration webhooks; retry once a minute for 30 minutes)
- https://developer.monday.com/api-reference/reference/webhooks
- https://developer.monday.com/apps/docs/integration-authorization
- https://community.monday.com/t/retry-policy-for-non-200-http-status-response/42999
- https://raw.githubusercontent.com/hookdeck/webhook-skills/main/skills/monday-webhooks/references/verification.md (third-party: HS256, claims, aud = endpoint URL)

## 3a. change_column_value / change_multiple_column_values / change_simple_column_value: signatures and JSON formats for text, status, email, phone, numbers, checkbox

_Confidence: high_

SIGNATURES: CONFIRMED VERBATIM in the SDL. create_labels_if_missing "Requires permission to change board structure". For change_simple_column_value, "pass null to empty the column".

FORMATS: CONFIRMED except where marked.
- text
  - JSON form: `"HDC-000123"`. For change_column_value, send JSON.stringify('HDC-000123').
  - Simple form: `HDC-000123`.
- status
  - `{"label":"Approved"}` or the simple string `Approved`.
  - Or `{"index":N}`.
  - If the label text is itself a number, you must send the index.
  - A column holds at most 40 labels.
  - CLARIFICATION (important trap): from 2025-10, read labels from `column.settings` (JSON). settings_str is deprecated in the SDL: "From version 2025-10, use settings instead".
    - In `settings.labels[]` each label has BOTH `id` (the stable label id) and `index` (its display POSITION), plus `is_done` and `is_deactivated`.
    - For writes and webhook configs, `{"index": N}` takes the label's stable id, i.e. `settings.labels[].id`, NOT `settings.labels[].index`.
    - Deactivated labels cannot be set.
  - Simplest robust approach for HDC: write by label text, and map incoming webhook events by `value.label.index` (which is the label id).
- email
  - JSON form: `{"email":"jane@example.com","text":"jane@example.com"}`.
  - Simple form: `jane@example.com Jane Doe`. The first token is the address and the rest is display text; the docs say both are required.
- phone
  - JSON form: `{"phone":"+12025550169","countryShortName":"US"}`.
  - Simple form: `+12025550169 US`. The country code is ISO-2, upper case, separated by a space.
- numbers
  - Write a string such as `"42.5"`.
  - CORRECTION: the Numbers docs say you can clear via change_multiple_column_values by passing null OR an empty string. The earlier claim that "" sets the value to 0 is contradicted. Use null to be safe.
- checkbox
  - `{"checked":"true"}`. Simple strings are NOT supported. Clear by passing null in change_multiple_column_values.

EXAMPLE CODE: correct as written. Use the real column ids from `boards(ids){ columns { id type title settings } }`; ids look like `text_mkx1abcd` or `files__1`, not the titles.

ECHO NOTE (valid): your own writes fire change_* webhooks with userId equal to the token owner. With an OAuth app token, writes are attributed to the authorizing user.

Sources:
- https://raw.githubusercontent.com/mondaycom/mcp/master/packages/agent-toolkit/src/monday-graphql/schema.graphql (mutation signatures; Column.settings_str @deprecated 'From version 2025-10, use settings instead')
- https://developer.monday.com/api-reference/changelog/deprecating-settings_str-field-on-columns
- https://developer.monday.com/api-reference/changelog?page=3 (2025-10: settings.labels with id, index, is_done, is_deactivated)
- https://developer.monday.com/api-reference/reference/managed-columns (index = label position)
- https://developer.monday.com/api-reference/reference/status
- https://developer.monday.com/api-reference/reference/email
- https://developer.monday.com/api-reference/docs/phone
- https://developer.monday.com/api-reference/reference/number (clear with null or empty string)
- https://developer.monday.com/api-reference/reference/checkbox

## 3b. create_update (HTML body), replies (parent_id), edit_update, and how to tell if an update was posted by our integration

_Confidence: high_

SIGNATURES: CONFIRMED VERBATIM in the SDL.
```graphql
create_update(body: String!, original_creation_date: String, mentions_list: [UpdateMention], item_id: ID, parent_id: ID, use_app_info: Boolean): Update
edit_update(id: ID!, body: String!): Update!
input UpdateMention { id: ID! type: MentionType! }   # User | Team | Project | Board | Agent
type Update { id body text_body creator_id: String creator item_id: String created_at updated_at edited_at: Date! replies: [Reply!] assets: [Asset] original_creation_date item likes pinned_to_top viewers }
type Reply  { id body text_body creator_id: String creator created_at updated_at kind: String! edited_at assets likes pinned_to_top viewers }
```
Root query: `updates(limit, page, ids: [ID!], from_date, to_date): [Update!]`. from_date and to_date are in the latest SDL; confirm them for 2026-10.

ARGUMENTS (confirmed)
- The SDL says of `body`: "Do not use @ to mention users, use the mentions field instead".
- Reply by passing `parent_id` and omitting item_id.
- `use_app_info` ("Use app info for the post creator") is ONLY in the latest SDL, which is likely 2027-01. It is absent from the @mondaydotcomorg/api 14.3.1 typings and undocumented. Do not use it on 2026-10 without checking get_schema?version=2026-10.

ADDED
- add_file_to_update(update_id, file) requires the OAuth scope `updates:write`, not boards:write.
- It also accepts a REPLY id to attach the file to a reply.

IS THIS UPDATE OURS? The approach is valid:
- Compare `me.id` with webhook `event.userId` and with `updates{creator_id}`.
- Also keep the set of update ids you created.
- Caveat confirmed: a shared human token makes that person's manual posts indistinguishable from the integration's. Use a dedicated Member seat, or a service user if it becomes available in your version (finding 1, unverified).

The code and the single-update query are correct as written.

Sources:
- https://raw.githubusercontent.com/mondaycom/mcp/master/packages/agent-toolkit/src/monday-graphql/schema.graphql (create_update, edit_update, Update, Reply, UpdateMention, MentionType, root updates)
- https://developer.monday.com/api-reference/reference/updates
- https://developer.monday.com/api-reference/reference/assets-1 (add_file_to_update: updates:write, reply id allowed)
- https://registry.npmjs.org/@mondaydotcomorg/api/-/api-14.3.1.tgz (no use_app_info in typings)

## 4a. Querying an item: column_values (incl. FileValue.files), updates, assets; getting downloadable file URLs (public_url expiry)

_Confidence: high_

SDL CONFIRMED, with additions.

ROOT QUERIES
- `items(exclude_nonactive, ids: [ID!], limit: Int = 25, newest_first, page): [Item]`.
- ADDED: `limit` defaults to 25 even when you pass ids, and the cap is 100 ids per call. When you pass N ids, set `limit: N`.
- Root `assets(ids: [ID!]!): [Asset]` is confirmed. Use it to mint a fresh public_url by asset id.

ITEM FIELDS
- assets(assets_source: all|columns|gallery, column_ids)
- column_values(capabilities, ids, types)
- updates(limit, page, ids)
- updates_page(limit, cursor): may be 2027-01 only; avoid it on 2026-10.
- Also: creator_id: String!, state, url, group, board.

FILE TYPES
- FileValue { files: [FileValueItem!]! text value }.
- FileValueItem = FileAssetInvalidValue | FileAssetValue | FileDocValue | FileLinkValue.
- FileAssetValue { asset_id asset name is_image created_at creator creator_id }.
- FileLinkValue { file_id name url kind created_at creator_id }.
- FileDocValue { file_id url doc object_id created_at creator_id }.

ASSET
- Asset { id name file_extension file_size created_at url url_thumbnail public_url original_geometry uploaded_by }.
- public_url is described as "public url to the asset, valid for 1 hour." Confirmed in the SDL and the docs.
- ADDED: each query returns a NEW public_url, valid for 1 hour.
- ADDED: anyone holding the link can download the file without a monday account while it is valid. Treat it as a secret: never log it or send it to the browser. Download server-side immediately.
- `url` (protected_static) needs a logged-in monday session. Community reports on API-token access are mixed (most say 401, one says it works after following a 302). Do not rely on it.

The GetClaim query and the mirroring loop are correct as written; all fragment fields exist in the SDL. Use real column ids for the shared-files column. Add/remove both fire change_specific_column_value, so diff asset ids via the API.

Sources:
- https://raw.githubusercontent.com/mondaycom/mcp/master/packages/agent-toolkit/src/monday-graphql/schema.graphql (Item, Asset.public_url description, FileValue, FileValueItem, root items/assets)
- https://developer.monday.com/api-reference/reference/assets-1
- https://developer.monday.com/api-reference/docs/items (ids max 100, limit default 25)
- https://developer.monday.com/api-reference/changelog/new-limits-to-the-items-query-in-90-days
- https://community.monday.com/t/remove-or-control-public-file-url-expiration/14686 (staff: each query returns a new 1-hour URL)
- https://community.monday.com/t/protected-static-content/10033

## 4b. create_notification for notifying team members

_Confidence: high_

CONFIRMED.
- SDL: `create_notification(user_id: ID!, target_id: ID!, text: String!, target_type: NotificationTargetType!): Notification`, with `enum NotificationTargetType { Project Post }` and `type Notification { id: ID! text: String }`. There is no `internal` argument.
- Official docs:
  - The notification goes to the bell and may also be emailed, depending on the recipient's preferences.
  - It is asynchronous, so the id cannot be queried back. The official example selects only `text`.
  - `Project` takes an item or board id; `Post` takes an update or reply id.
- monday's agent-toolkit 5.77.0 does select `id` and errors if it is missing ("Verify the user has access to the target and that target_id matches target_type"). Requesting `{ id text }` works in practice, but don't build logic that depends on the id.
- ADDED (community):
  - Pass target_type as an enum, e.g. a `$type: NotificationTargetType!` variable as in the code. A quoted string inline in the query gives an "Unauthorized field or type" error.
  - Some developers found board ids do not work as a `Project` target; use the ITEM id.
- Code: correct as written. One user per call.

Sources:
- https://raw.githubusercontent.com/mondaycom/mcp/master/packages/agent-toolkit/src/monday-graphql/schema.graphql
- https://developer.monday.com/api-reference/reference/notification (WebSearch extract)
- https://developer-community.monday.com/api-apps-framework-4/unauthorised-field-or-type-error-when-calling-create-notification-mutation-570
- https://registry.npmjs.org/@mondaydotcomorg/agent-toolkit/-/agent-toolkit-5.77.0.tgz (inspected createNotification error text)

## 5. Uploading a file to a file column: add_file_to_column via multipart POST to /v2/file, field names, size limits

_Confidence: medium_

MOSTLY CONFIRMED.
- SDL: `add_file_to_column(item_id: ID!, column_id: String!, file: File!): Asset` and `add_file_to_update(update_id: ID!, file: File!): Asset`.
- Endpoint and limit (official): POST https://api.monday.com/v2/file, multipart/form-data, files up to 500 MB.
- The docs say add_file_to_column "cannot be sent as a standard JSON request to the /v2 endpoint".
- Form fields follow the docs example: `query`, optional `variables`, `map` as `{"image":"variables.file"}`, and the file part under that field name.
- Scopes: add_file_to_column needs `boards:write`. ADDED: add_file_to_update needs `updates:write`, and its update_id may be a reply id.
- Do not set Content-Type yourself. Community 400 "Unsupported query" errors come from manual headers or JSON bodies.
- "/v2 only ~1 MB": this comes from a 2021 staff forum reply that the regular endpoint has a lower limit. It is not a current documented number, so treat it as unverified.
- The official SDK's FormData builder uses the spec map form `{"0":["variables.file"]}`. The only endpoint string in the bundle is https://api.monday.com/v2 (confirmed). Use /v2/file directly, as in the code.
- ADDED pitfall: use the real file-column id (e.g. `files__1`). One report shows the doc's literal "files" id returned 500 while the upload still landed, so check for a duplicate upload before retrying.
- "Agent API keys get Unauthorized for both mutations": NOT verified (no source found). Irrelevant if you use a personal or OAuth token.
- appends rather than replaces: consistent with the docs ("adds a file"). There is no replace mutation.
- Node and curl code: correct as written. Add an Idempotency-Key header only if you confirm it is honoured on /v2/file; this is undocumented.
- Echo note: the upload fires your files-column webhook with your user id. Valid.

Sources:
- https://developer.monday.com/api-reference/reference/assets-1 (WebSearch extract: /v2/file, 500 MB, multipart required, scopes)
- https://developer.monday.com/api-reference/reference/files-1
- https://community.monday.com/t/announcement-uploading-files-to-monday-com-has-just-become-easier/16803
- https://community.monday.com/t/documentation-issue-add-file-to-the-file-column/101168 (files vs files__1)
- https://registry.npmjs.org/@mondaydotcomorg/api/-/api-14.3.1.tgz (inspected FormData builder and endpoint)
- https://raw.githubusercontent.com/mondaycom/mcp/master/packages/agent-toolkit/src/monday-graphql/schema.graphql

## 6. Rate limits / complexity budget / minute limits, error codes, and recommended retry (incl. idempotency)

_Confidence: medium_

CORRECTED.

COMPLEXITY (rate-limits page, via search extract)
- Personal API token: reads and writes share 10M points per minute (1M for trial, NGO and free accounts).
- App tokens: 5M reads per minute and 5M writes per minute.
- The window slides: it resets 60 s after the first call.
- Single query: at most 5M points (REQUEST_MAX_COMPLEXITY_EXCEEDED).
- The "Build on monday with AI" page instead lists 5M per minute for all plans (and 20M for agents). Conflict unresolved.
- Per a monday staff reply, the budget is per ACCOUNT, shared by all tokens and users.

MINUTE LIMIT, CONCURRENCY, IP (official AI-page table; corroborated)
- Requests per minute: 1,000 (free and lower) / 2,500 (Pro) / 5,000 (Enterprise).
- Concurrency: 40 / 100 / 250.
- IP limit: 5,000 requests per 10 seconds.

DAILY CALLS (CORRECTED)
- support.monday.com: Free/Trial 200, Basic/Standard 1,000, Pro 10,000 (soft), Enterprise 25,000 (soft). The dev-docs table shows Free as 1,000.
- Resets at midnight UTC.
- Counts calls from personal tokens, private apps, public apps (excluding marketplace and monday-built apps) and hosted Platform MCP.
- Requests that hit a rate limit count as 0.1 each.
- "Errors and failed calls also count": NOT confirmed.
- Exceeding the limit gives DAILY_LIMIT_EXCEEDED. Do NOT retry that until 00:00 UTC.
- HDC's monday PLAN IS UNKNOWN. On Standard (1,000 per day), a few calls per event could hit the cap. Confirm the plan.

ERRORS (CORRECTED)
- Since API 2025-07, COMPLEXITY_BUDGET_EXHAUSTED no longer includes complexity, complexity_budget_left or status_code (and no budget-limit field). It is aligned with other rate errors: use `extensions.retry_in_seconds`, and read the budget from the `complexity { before query after reset_in_x_seconds }` field.
- Every rate-limit error carries retry_in_seconds.
- The minute-limit 429 also sends a `Retry-After` header.
- The concurrency error is reported as `maxConcurrencyExceeded`.
- IDEMPOTENCY_CONFLICT is a 409 with Retry-After.
- Application-level errors can come back as HTTP 200 with `errors[]`. Check both.

IDEMPOTENCY (official)
- The `Idempotency-Key` header works on mutations and is ignored on queries.
- The first response is cached for 30 minutes. A replay returns the cached response with `Idempotency-Replayed: true`. A concurrent duplicate gets 409.
- The SDK sends the header from `idempotencyKey` (confirmed in the bundle).
- The '>1 MB not cached' and 'per-user/app cache budget' rules: NOT confirmed. The rules table was truncated in the extracts.

CLIENT FIXES
- A 429 means the request was not executed, so retry it.
- Retry 5xx, timeouts and network errors ONLY for queries, or for mutations that carry an Idempotency-Key. Otherwise create_update or add_file could duplicate.
- Stop on DAILY_LIMIT_EXCEEDED.
```ts
const isMutation = /^\s*mutation\b/.test(query);
const safe = !isMutation || !!opts.idempotencyKey;
// network error branch: if (!safe || attempt >= max) throw e;
const code = errs[0]?.extensions?.code;
if (code === 'DAILY_LIMIT_EXCEEDED') throw new MondayError(errs, res.status);   // park the job until 00:00 UTC
const rateLimited = res.status === 429 || ['COMPLEXITY_BUDGET_EXHAUSTED','RATE_LIMIT_EXCEEDED','maxConcurrencyExceeded'].includes(code);
const retryable = rateLimited || res.status === 409 || code === 'IDEMPOTENCY_CONFLICT' || (safe && res.status >= 500);
// wait: Number(ext.retry_in_seconds) || Retry-After header || backoff(attempt)
```
The rest of the client and the concurrency advice (queue with 5–10 workers, keyed by pulseId) are fine.

Sources:
- https://developer.monday.com/api-reference/docs/rate-limits (WebSearch extract: 10M personal / 1M trial-free-NGO, 5M+5M app, 5M per query, retry_in_seconds, Retry-After, 0.1 calls, DAILY_LIMIT_EXCEEDED, MCP calls count)
- https://developer.monday.com/api-reference/docs/build-on-monday-with-ai (plan table: 1,000/2,500/5,000 per min; 40/100/250 concurrency; 5,000 per 10 s IP; 5M complexity)
- https://support.monday.com/hc/en-us/articles/26471164460690-API-Rate-Limits (daily: 200/1,000/10,000/25,000; maxConcurrencyExceeded)
- https://developer.monday.com/api-reference/changelog/breaking-change-updated-complexity-budget-exhausted-error (2025-07 removal of budget fields)
- https://developer.monday.com/api-reference/docs/idempotency
- https://developer.monday.com/api-reference/docs/error-handling (IDEMPOTENCY_CONFLICT 409)
- https://developer-community.monday.com/product-updates/rate-limit-improvements-621 (limits per account)
- https://registry.npmjs.org/@mondaydotcomorg/api/-/api-14.3.1.tgz (Idempotency-Key header)

## End-to-end flow notes specific to HDC (WorkForm create_item, claim number, echo suppression)

_Confidence: medium_

1. WorkForm submission
- The form writes an item to its backing board. Confirmed: monday's Platform MCP docs describe form submissions as creating items on the backing board.
- Still UNDOCUMENTED: whether a WorkForm submission fires create_item, and which userId it carries. Verify with a test submission.
- Re-query the item with `items(ids:[pulseId], limit:1)` to read the answers.

2. Claim number
- Allocate from your own DB sequence, keyed on pulseId inside a transaction.
- Write with change_simple_column_value and Idempotency-Key `hdc:claimno:${itemId}`.
- The echo is suppressed because event.userId === me.id.

3. Status
- Subscribe with config `{columnId, columnValue:{$any$:true}}`.
- Map by `ev.value.label.index`, which is the stable label id (= settings.labels[].id), so admin renames don't break templates. Keep the label text for display only.

4. Updates
- Skip echoes, re-query, and publish text_body or sanitized body.
- There is no private-update flag in the API, so the convention approach stands.
- Replies firing create_update: unverified; test it.

5. Files
- Use change_specific_column_value on the claimant-shared file column, then diff assets(column_ids) and download public_url server-side within 1 hour. Never expose public_url.

6. Webhook registry
- Store your webhook ids per board and kind. The Webhook type has no url, so you cannot identify your webhooks by listing.
- Register a per-kind URL that contains the path secret.

7. Bank-details board
- Keep it separate and unsubscribed; never log its payloads.

8. Integration identity
- Use a dedicated paid Member seat; guests and viewers cannot use the API.
- Or use a service user if your API version and monday confirm it exists (unverified for 2026-10).

9. Plan check
- Confirm HDC's monday plan: daily call caps run from 1,000 (Standard) to 25,000 (Enterprise).
- Check in Integrations Center > Account usage whether API-created webhook deliveries count against the monthly integration-action quota (Standard 250 per month, Pro 25,000 per month). This is unverified.

Sources:
- https://developer.monday.com/api-reference/docs/create-form-submission
- https://developer.monday.com/api-reference/docs/create-form
- https://developer.monday.com/api-reference/reference/webhooks
- https://developer.monday.com/api-reference/docs/idempotency
- https://support.monday.com/hc/en-us/articles/360002826680-Automations-and-integrations-pricing (integration action quotas by plan)
- https://raw.githubusercontent.com/mondaycom/mcp/master/packages/agent-toolkit/src/monday-graphql/schema.graphql

## Gaps and risks

- Verification tooling: developer.monday.com, support.monday.com and api.monday.com were unreachable from this sandbox (WebFetch DNS failure; proxy 403 on CONNECT). Official doc claims were checked via WebSearch extracts. Signatures were checked directly against monday's official SDL (raw.githubusercontent.com mondaycom/mcp master) and against the npm tarballs @mondaydotcomorg/api 14.3.1 and @mondaydotcomorg/agent-toolkit 5.77.0. The per-turn web-search budget ran out before every open point could be checked; see the unverified items below.
- The SDL used is almost certainly the 2027-01 RC schema: mcp master version.utils.ts says '2027-01'. These fields may not exist in 2026-10: create_update.use_app_info, Item.updates_page, the service-user mutations and queries, column_values(capabilities), and updates(from_date, to_date). Run get_schema?format=sdl&version=2026-10 (or introspection) from a host that can reach api.monday.com before coding against them.
- API version: 2026-10 has been Current since 2026-10-01 per the official versioning table. 2027-01 becomes Current on 2027-01-15, not 2027-01-01, and 2026-10 enters Maintenance the same day. 2026-10 removes legacy User fields (is_admin, is_guest, enabled, photo_*, is_pending, join_date, sign_up_product_kind).
- Correction: COMPLEXITY_BUDGET_EXHAUSTED responses (API 2025-07 and later) no longer include complexity, complexity_budget_left or status_code. Rely on extensions.retry_in_seconds and the complexity query field.
- Correction: daily call limits from the support article are Free/Trial 200, Basic/Standard 1,000, Pro 10,000 (soft), Enterprise 25,000 (soft). The dev docs list Free as 1,000. HDC's plan is unknown, and on Standard the 1,000-per-day cap could bind. DAILY_LIMIT_EXCEEDED must not be retried until 00:00 UTC.
- Correction: the Numbers column clears with null OR "" per the docs. The earlier claim that "" sets the value to 0 is contradicted.
- Status label trap: in the 2025-10+ `settings` JSON each label has both `id` (stable) and `index` (display position). Writes and webhook configs that use {"index": N} expect the label id (settings.labels[].id), not settings.labels[].index.
- The Webhook type has no `url` field. With a personal token you cannot tell your webhooks apart from other tools' webhooks when listing. Persist the ids returned by create_webhook. The original reconcile, which skipped creation if any webhook with the same event existed, could silently leave HDC without its webhook.
- Handler bugs in the original code: the JWT check was bypassable by omitting the header; a single-env-var audience breaks with per-kind URLs (aud = registered webhook URL); and acking 200 before a durable enqueue loses events, because monday does not retry after a 200. All are fixed in finding 2c.
- Retry safety: retrying 5xx or network failures on mutations without an Idempotency-Key can duplicate create_update, add_file_to_column and similar writes. Only 429 (not executed) is always safe to retry.
- Unverified:
- the 255-character webhook URL limit (third-party only)
- the /v2 ~1 MB upload limit (2021 forum)
- Agent API keys being unauthorized for file mutations
- the idempotency rules table (1 MB response cap, cache budget)
- whether errors and failed calls count toward the daily limit
- personal-token complexity of 10M (rate-limits page) vs 5M for all plans (AI page)
- Undocumented, so test on a sandbox board:
- whether WorkForm submissions fire create_item and with which userId
- whether create_update fires for replies and how replyId is populated
- the edit_update payload
- the file-column change payload
- webhook delivery timeout and ordering
- the exact JWT aud format
- Plan or quota risk not resolved (search budget exhausted): whether API-created webhook deliveries count toward monday's monthly integration-action quota (Standard 250 per month, Pro 25,000 per month). Check Integrations Center > Account usage after a test.
- Identity: the API is available only to admins and members (not guests or viewers). A dedicated integration identity therefore costs a paid Member seat. Service users appear in the latest SDL but are undocumented and unconfirmed for 2026-10.
- public_url gives anyone with the link unauthenticated access for 1 hour, and each query mints a new one. Treat it as a secret: never log it or send it to the claimant's browser. Download server-side and serve from your own storage.
