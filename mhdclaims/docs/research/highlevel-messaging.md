# HighLevel (LeadConnector) API v2: sending email and SMS to claimants and receiving replies, for the HomeDeliveryClaims.com Node/TypeScript integration service. Verified against the docs repo GoHighLevel/highlevel-api-docs (HEAD 0af86a4, 2026-06-19, plus history back to 2025-06) and the @gohighlevel/api-client v3.1.1 tarball. Help-center pages could not be fetched, and the web-search budget ran out partway through.

## 1. Base URL, auth options for one sub-account (Private Integration Token or OAuth marketplace app), required headers including the Version value, and scopes needed

_Confidence: high_

VERIFIED: the base URL is https://services.leadconnectorhq.com. Every relevant spec file (conversations, contacts, locations, oauth) has servers[0].url set to it.

HEADERS: Authorization: Bearer <token>; Version: <per endpoint>; Content-Type: application/json (multipart/form-data for /conversations/messages/upload; application/x-www-form-urlencoded for /oauth/token); Accept: application/json.

VERSION VALUES (verified, each endpoint's Version enum has exactly one value):
- '2021-04-15' for every /conversations/* operation: POST /conversations/messages, /messages/upload, /upload/initiate, /upload/complete, GET /conversations/search, GET /conversations/messages/{id}, GET /conversations/preferences/unsubscriptions/status, and the rest. Exceptions: GET /conversations/messages/email/{id} and DELETE .../email/{emailMessageId}/schedule declare no Version parameter.
- '2021-07-28' for /contacts/*, /locations/{locationId}/customFields, and /proposals/document/send and /proposals/templates/send.
VERIFIED about the SDK: @gohighlevel/api-client 3.1.1 (npm, modified 2026-10-13) defaults apiVersion to '2023-02-21' and sends that header on every call unless one is already set (dist/lib/HighLevel.js, lines 127 and 598-602). Use the per-endpoint values anyway.
NEW: the docs repo added 'v3' spec files on 2026-06-19 (apps/v3/*.json, header 'Version: v3', same paths and same SendMessageBodyDto). They are not referenced in toc.json. Don't adopt v3 until HighLevel publishes it; the dated v2 values above are what the published v2 specs define.

PIT COMPATIBILITY (verified): all endpoints this project needs (send message, upload, upsert, tags, get contact, customFields, conversations search, proposals send) use the 'bearer' or 'Location-Access' security schemes. Both say: 'Use the Access Token generated with user type as Sub-Account (OR) Private Integration Token of Sub-Account.' None of them uses the '*-Only' schemes that exclude PITs.

AUTH OPTION A: Private Integration Token (PIT)
- Created in the sub-account under Settings > Private Integrations. Sent as 'Authorization: Bearer <PIT>'. Described as a static or fixed OAuth2 access token that does not auto-refresh.
- Rotation (partly verified, via secondary sources): 'Rotate and expire this token later' gives a 7-day overlap; 'Rotate and expire this token now' revokes immediately.
- NOT VERIFIED: the '90-day rotation recommendation' and the '20 PITs per account' cap. The 90-day figure came from a third-party help site. I found nothing on the cap. The sandbox-PIT doc only says to rotate periodically. Also unconfirmed: whether scopes can be edited after the token is created.
- Webhooks: the docs repo FAQ (docs/oauth/Faqs.md) describes webhook subscription only through a registered Marketplace app ('Register for an app... update the webhook url... add the scope needed for the webhook event'). A 2023 HighLevel changelog listed 'subscribe to Webhook events in Private Integrations' under 'What's next', and I found no evidence it shipped. Treat a PIT as giving you no native InboundMessage webhooks.

AUTH OPTION B: OAuth 2.0 Marketplace app (needed for signed native InboundMessage, OutboundMessage and ContactDndUpdate)
1. Go to https://marketplace.gohighlevel.com, then My Apps > Create App. Configure scopes, keys, webhook URL and events in the app settings. The exact names of the distribution and target settings were not verified.
2. Install URL (verified; the docs changed it to the /v2/ path on 2026-05-27, commit ae4d260):
   https://marketplace.gohighlevel.com/v2/oauth/chooselocation?response_type=code&redirect_uri=<url>&client_id=<id>&scope=<space-separated scopes>
   The white-label host is marketplace.leadconnectorhq.com/v2/oauth/chooselocation. You can append '&loginWindowOpenMode=self' to log in in the same tab.
3. Exchange the code with POST https://services.leadconnectorhq.com/oauth/token, form-urlencoded. Fields: client_id, client_secret, grant_type ('authorization_code' | 'refresh_token' | 'client_credentials'), code, refresh_token, user_type ('Company' | 'Location'), redirect_uri. Required: client_id, client_secret and grant_type.
   Response (GetAccessCodeSuccessfulResponseDto): access_token, token_type, expires_in (example 86399), refresh_token, scope, userType, locationId, companyId, approvedLocations, userId (the only required field), planId, isBulkInstallation, installToFutureLocations, approveAllLocations.
4. Verified in Authorization.md: access tokens last about a day. Refresh tokens are valid for a year until used, and each refresh returns a new refresh token, so save it every time. On an expired-token response, refresh, save both tokens, and retry.

RECOMMENDATION (unchanged): a Marketplace app installed only on the claims sub-account, for signed native webhooks. Or a PIT plus a workflow webhook (Q4 option B) if you want to avoid OAuth.

SCOPES (verified against docs/oauth/Scopes.md and the operation security blocks):
- contacts.write: upsert, create, update, tags, notes.
- contacts.readonly: GET /contacts/{id}, plus the ContactCreate and ContactDndUpdate webhooks.
- conversations/message.write: POST /conversations/messages, /messages/inbound, /messages/upload, /upload/initiate, /upload/complete, PUT /messages/{id}/status.
- conversations/message.readonly: GET messages, plus the InboundMessage and OutboundMessage webhooks.
- conversations.readonly: GET /conversations/search, GET /conversations/{id}, plus ConversationUnreadWebhook.
- conversations.write: POST /conversations/ (create) and PUT/DELETE a conversation. Only needed if you create a conversation before an upload (see Q3).
- locations/customFields.readonly: GET /locations/{locationId}/customFields.
GET /conversations/preferences/unsubscriptions/status declares no scope in the spec.

Sources:
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/conversations.json
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/contacts.json
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/locations.json
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/oauth.json
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/docs/oauth/Authorization.md
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/docs/oauth/Scopes.md
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/docs/oauth/Faqs.md
- https://github.com/GoHighLevel/highlevel-api-docs/commit/ae4d260aada8e4340e1603a5573f977778e13ffd
- https://github.com/GoHighLevel/highlevel-api-docs/tree/main/apps/v3
- https://www.npmjs.com/package/@gohighlevel/api-client
- https://marketplace.gohighlevel.com/docs/Authorization/PrivateIntegrationsToken/
- https://ideas.gohighlevel.com/changelog/private-integrations-for-agencies
- https://docs.gitguardian.com/secrets-detection/secrets-detection-engine/detectors/specifics/hl_private_integration_token

## 2. Contacts: POST /contacts/upsert request and response shape (locationId, email, phone, tags, customFields) and the DND / SMS consent fields

_Confidence: high_

VERIFIED: POST https://services.leadconnectorhq.com/contacts/upsert, operationId upsert-contact, Version 2021-07-28, scope contacts.write.

REQUEST (UpsertContactDto). Only locationId is required. Properties: firstName, lastName, name, email, locationId, gender, phone, address1, city, state, postalCode, website, timezone, dnd, dndSettings, inboundDndSettings, tags, customFields, source, dateOfBirth, country, companyName, assignedTo, createNewIfDuplicateAllowed (default false).
Example:
{
  "locationId": "<LOCATION_ID>", "firstName": "Jane", "lastName": "Doe",
  "email": "jane@example.com", "phone": "+15555550123",
  "source": "HomeDeliveryClaims.com",
  "customFields": [ { "id": "<CF_ID_CLAIM_NUMBER>", "field_value": "HDC-000123" } ]
}

- tags (verified quote): 'This field will overwrite all current tags associated with the contact. To update a tags, it is recommended to use the Add Tag or Remove Tag API instead.' Use POST /contacts/{contactId}/tags or DELETE /contacts/{contactId}/tags, each with body TagsDTO {"tags": [string]} (required). Version 2021-07-28, contacts.write.
- customFields items (verified): anyOf TextField, LargeTextField, SingleSelectField, RadioField, NumericField, MonetoryField (sic), CheckboxField, MultiSelectField, FileField. Each item is {id (required), key?, field_value}. field_value is a string for text, large text, single-select and radio; string[] for checkbox and multi-select. Numeric and monetary are typed 'object' in the spec but the examples are numbers (100, 100.5). FileField takes an object keyed by uuid.
- Custom field IDs (verified): GET /locations/{locationId}/customFields?model=contact. model is one of contact | opportunity | all. Version 2021-07-28, scope locations/customFields.readonly. Each item has id, name, fieldKey, placeholder, dataType, position, picklistOptions, and more.
- Read vs write shape (verified): the response contact.customFields is an array of {id, value}, while the request uses field_value.
- Matching (verified quote from the endpoint description): upsert follows the location's 'Allow Duplicate Contact' setting. If two different contacts match the email and the phone, the contact matching the first field in the configured sequence is updated and the second field is ignored. createNewIfDuplicateAllowed=true creates a new contact only if the location allows duplicates.
- Phone: the spec example is '+1 888-888-8888'. Send E.164.

RESPONSE 200 (verified, UpsertContactsSuccessfulResponseDto): { "new": boolean, "contact": GetContectByIdSchema, "traceId": string }.
contact fields: id, name, locationId, firstName, lastName, email, emailLowerCase, timezone, companyName, phone, dnd, dndSettings, type, source, assignedTo, address1, city, state, country, postalCode, website, tags, dateOfBirth, dateAdded, dateUpdated, attachments, ssn, keyword, lastActivity, customFields, businessId, attributionSource, lastAttributionSource, visitorId. The documented response does NOT include inboundDndSettings.
GET /contacts/{contactId} returns { "contact": {...} } (ContactsByIdSuccessfulResponseDto).

DND / CONSENT (verified schemas):
- dnd: boolean.
- dndSettings: {Call, Email, SMS, WhatsApp, GMB, FB}. Each is {status: 'active' | 'inactive' | 'permanent' (required), message?, code?}.
- inboundDndSettings: {all: {status: 'active' | 'inactive', message?}}.
- There is no SMS-consent boolean or timestamp field. Store consent proof in your own custom fields (sms_consent, sms_consent_at, sms_consent_ip, consent_text_version) and on the Monday item.
- Opt-outs: STOP (and STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT) puts the contact on permanent SMS DND. HighLevel's policy says neither the agency nor the location can revoke it; the contact has to text START, YES or UNSTOP. (Confirmed via search of the LC Phone messaging policy and DND article.) Never send dndSettings on routine upserts. Set dndSettings.SMS.status='active' only when a claimant opts out in your portal.
- ContactDndUpdate webhook (verified, Marketplace app, scope contacts.readonly): payload has type, locationId, id, address fields, dnd, and dndSettings.{SMS, Email, GMB, FB, WhatsApp, ...}.{status, message, code}.
- Email unsubscribe status (verified): GET /conversations/preferences/unsubscriptions/status?locationId=&contactId=&email=. locationId and contactId are required, email is optional. Version 2021-04-15. The 200 response schema is undocumented.

CODE: the original upsertClaimant() matches the spec: upsert with customFields [{id, field_value}], then POST /contacts/{id}/tags with {tags: [...]}, returning r.contact.id. No changes needed.

Sources:
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/contacts.json
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/locations.json
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/conversations.json
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/docs/webhook%20events/ContactDndUpdate.md
- https://help.gohighlevel.com/support/solutions/articles/48001213941-lc-phone-messaging-policy
- https://help.gohighlevel.com/support/solutions/articles/48001214849

## 3. Sending messages: exact POST /conversations/messages body for type SMS and Email (contactId, message, html, subject, emailFrom, replyTo, attachments) and the response shape

_Confidence: medium_

VERIFIED: POST https://services.leadconnectorhq.com/conversations/messages, operationId send-a-new-message, Version 2021-04-15, scope conversations/message.write.

SendMessageBodyDto properties (verified at HEAD 0af86a4; spec synced 2026-05-01 in d9cbcd5):
- type: SMS | RCS | Email | WhatsApp | IG | FB | Custom | Live_Chat | TIKTOK
- subType (object, no values documented)
- contactId, appointmentId
- attachments: string[] of URLs
- emailFrom, emailCc: string[], emailBcc: string[], emailTo (must be an address associated with the contact)
- html, message, subject
- replyMessageId, templateId
- threadId: for email, the message id that holds the thread
- scheduledTimestamp: UTC seconds
- conversationProviderId, customSubtypeId: email unsubscription category
- emailReplyMode: reply | reply_all
- fromNumber, toNumber
- forward: {isForwarded, forwardWholeThread, messageId, emailMessageId, toEmail, recipientContactId}
- status: delivered | failed | pending | read
- usesNativeSchedulingAi, optimizationPeriod: 24h | 48h | 72h

REQUIRED-FIELD DISCREPANCY (verified from git history): the current spec says required = [type, subType, contactId, status]. At commit de87e88 (2025-08-26), and right before d9cbcd5 (2026-05-01), it was [type, contactId], and subType and status did not exist. Send the minimal body first, and add fields only if you get a 400 that names them. The v3 spec has the same required list.

There is NO replyTo field (verified). Reply-to is configured at the sub-account level. A Reply & Forward address sends replies to that inbox instead of Conversations, so no InboundMessage fires; leave it unset. (Help-center behavior not re-fetched in this pass.)

SMS: {"type":"SMS","contactId":"...","message":"HomeDeliveryClaims: Claim HDC-000123 is now Under Review. Details: https://homedeliveryclaims.com/c/HDC-000123 Reply HELP for help, STOP to opt out."}
Optional: fromNumber (A2P-registered number), attachments (MMS URLs), scheduledTimestamp.

EMAIL: {"type":"Email","contactId":"...","subject":"...","html":"<p>...</p>","emailFrom":"claims@mail.homedeliveryclaims.com","attachments":["https://..."]}
To reply in a thread, add threadId, replyMessageId and emailReplyMode:'reply'. Whether emailFrom accepts 'Name <addr>' is undocumented; test it.

RESPONSE 200 (verified, SendMessageResponseDto; required: conversationId, messageId, status):
- conversationId, messageId
- emailMessageId: Email only; per the spec, use it to thread inbound replies
- messageIds: GMB only
- msg: workflow sends
- forwardData (the original finding left this out): {forwardWholeThread, messageId, emailMessageId, forwardToEmail, recipientContactId}
- status: delivered | failed | pending | read
Errors: 400 BadRequestDTO, 401 UnauthorizedDTO. Store messageId and conversationId. You also need them to dedupe your own sends when they come back as OutboundMessage events (see Q4).

ATTACHMENTS (verified, with one correction):
POST /conversations/messages/upload, multipart/form-data, Version 2021-04-15.
- The file goes in the form key 'fileAttachment'.
- Allowed types: JPG, JPEG, PNG, MP4, MPEG, ZIP, RAR, PDF, DOC, DOCX, TXT, MP3, WAV.
- Response: {uploadedFiles: {<filename>: <url>}, twilioMediaSids?}. Errors 413 and 415 return {status, message}.
- CORRECTION: UploadFilesDto marks conversationId, contactId, locationId AND attachmentUrls as required. So you need an existing conversationId before you can upload: send a text message first, or create one with POST /conversations/ (conversations.write). attachmentUrls being required looks like a spec quirk; test it.
- Signed-URL flow (verified):
  1. POST /conversations/messages/upload/initiate {locationId, conversationId, filename, contentType, channel, fileSize?} returns {uploadUrl, uploadId, filePath, expiresAt, maxFileSize}.
  2. PUT the bytes to uploadUrl.
  3. POST /conversations/messages/upload/complete {uploadId, filePath, locationId, conversationId, filename} returns {uploadedFiles, metadata}.
  The limit is 100MB for channel WHATSAPP and 5MB for others.
For claim documents, prefer portal links over attaching PII.

CODE: the original sendSms and sendEmail helpers match the spec. No changes needed.

Sources:
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/conversations.json
- https://github.com/GoHighLevel/highlevel-api-docs/commit/d9cbcd5
- https://github.com/GoHighLevel/highlevel-api-docs/commit/de87e88
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/v3/conversations-v3.json
- https://marketplace.gohighlevel.com/docs/ghl/conversations/send-a-new-message
- https://help.gohighlevel.com/support/solutions/articles/48001155000-email-services-configuration-reply-forward-settings

## 4. Inbound replies: InboundMessage webhook (marketplace app) vs a Workflow 'Customer Replied' trigger plus Webhook action (private integration); exact InboundMessage payload fields; how to verify webhook authenticity

_Confidence: medium_

OPTION A: Marketplace app InboundMessage webhook (recommended)
Scope: conversations/message.readonly, which also covers OutboundMessage. Add contacts.readonly for ContactDndUpdate. InboundMessage channels (verified): Call, Voicemail, SMS, GMB, FB, IG, Email, Live Chat.

SMS PAYLOAD (verified schema): type, locationId, attachments[], body, contactId, contentType, conversationId, dateAdded, direction, messageType, status, messageId, userId, conversationProviderId, callDuration, callStatus.
Example: {"type":"InboundMessage","locationId":"l1C08ntBrFjLS0elLIYU","attachments":[],"body":"This is a test message","contactId":"cI08i1Bls3iTB9bKgFJh","contentType":"text/plain","conversationId":"fcanlLgpbQgQhderivVs","dateAdded":"2021-04-21T11:31:45.750Z","direction":"inbound","messageType":"SMS","status":"delivered","conversationProviderId":"cI08i1Bls3iTB9bKgF01"}
- Call examples use messageType 'CALL' (uppercase); voicemail has status 'voicemail'.
- There is no sender phone number in the payload. Resolve the contact with GET /contacts/{contactId} (Version 2021-07-28), which returns {contact}, then read the claim_number custom field from contact.customFields[{id, value}].

EMAIL PAYLOAD (verified):
- The JSON schema lists type, locationId, attachments, body, contactId, conversationId, dateAdded, direction, messageType, emailMessageId, threadId, provider, to, cc, bcc, userId, conversationProviderId.
- CORRECTION: 'from' and 'subject' appear only in the example, not in the schema.
- The schema types to, cc and bcc as strings, but the example sends to as an array. Handle both.
- body is HTML with quoted history; strip it.

TWILIO CAVEAT (new, verified in InboundMessage.md): if the sub-account uses its own Twilio account instead of LC Phone, set the Twilio number's 'A Message comes in' webhook to https://services.leadconnectorhq.com/conversations/providers/twilio/inbound_message. Otherwise inbound SMS won't reach HighLevel.

OUTBOUNDMESSAGE (correction): the webhook doc types 'source' only as a string, and its examples use 'app'. The enum workflow | bulk_actions | campaign | api | app in the original finding comes from the REST API's email-message schema ('Email source'), not from the webhook doc. Don't rely on source==='api' to drop your own sends. Instead, skip events whose messageId you stored from the send response.

VERIFYING AUTHENTICITY (updated)
- Current mechanism (verified in the SDK 3.1.1 README and source): header 'x-ghl-signature', an Ed25519 signature, base64, over the exact raw body bytes. The SDK verifies it with crypto.verify(null, rawBody, key, Buffer.from(sig, 'base64')) and accepts the key as PEM, or as a raw 32-byte key in base64 or hex. It also provides ghl.webhooks.verifyEd25519Signature(rawBody, sig, publicKey) and the ghl.webhooks.subscribe() middleware.
- The Ed25519 public key, as quoted from the official Webhook Integration Guide by two independent secondary sources (a search summary of the guide, and the ghl-tenant-bridge repo, which says it read the guide on 2026-08-19 and test-diffs against the published keys):
  -----BEGIN PUBLIC KEY-----
  MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
  -----END PUBLIC KEY-----
  I checked it is a well-formed 44-byte Ed25519 SPKI (DER prefix 302a300506032b6570032100). I could not read the official page directly, so confirm the key there before shipping.
- Legacy mechanism: 'x-wh-signature', RSA-SHA256. Its 4096-bit RSA key is in docs/oauth/WebhookAuthentication.md, and the same key appears in the third-party repo. The deprecation date is 2026-07-01 per one search summary of the guide and 2026-09-01 per other sources. Both dates are now past (today is 2026-10-22), and the SDK says 'The legacy x-wh-signature header (RSA) is no longer sent by HighLevel.' Drop the RSA path, and reject any request without x-ghl-signature.
- RETRIES (conflict resolved): in GitHub issue #257, a HighLevel staff member said on 2026-04-30 that retries for non-2xx webhook responses are 'now live'. The Marketplace Webhook Logs Dashboard doc says: for any non-2xx response and for transport failures, up to 12 retries (not counting the original) with exponential backoff and jitter. A newer help article says 429s keep the old behavior while non-429 failures can keep retrying for up to about 3 days. The 'only 429 is retried' statement predates this and is outdated.
- REPLAY WINDOW (correction to the original code): do NOT drop events whose body timestamp is more than 5 minutes old. Retries can arrive hours or days later, and the docs don't say whether 'timestamp' is refreshed on each retry. The original code returned 200 for those events, which acknowledges them and loses them silently. Rely on the Ed25519 signature plus idempotent dedupe. Log stale timestamps instead of discarding them.
- DEDUPE: prefer `${type}:${messageId}`, since messageId is stable per message. Fall back to webhookId; whether webhookId stays the same across retries is undocumented.

CODE (corrected):
import crypto from 'node:crypto'; import express from 'express';
const GHL_ED25519_PEM = process.env.GHL_WEBHOOK_ED25519_PUBLIC_KEY_PEM ?? '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=\n-----END PUBLIC KEY-----';
const ED_KEY = crypto.createPublicKey(GHL_ED25519_PEM);
// Register this route BEFORE any global express.json(), or req.body will no longer be the raw bytes.
app.post('/webhooks/ghl', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const raw = req.body as Buffer; const sig = req.header('x-ghl-signature');
  let ok = false; try { ok = !!sig && crypto.verify(null, raw, ED_KEY, Buffer.from(sig, 'base64')); } catch { ok = false; }
  if (!ok) return res.sendStatus(401);
  const evt = JSON.parse(raw.toString('utf8'));
  const key = evt.messageId ? `${evt.type}:${evt.messageId}` : (evt.webhookId ?? crypto.createHash('sha256').update(raw).digest('hex'));
  try { await queue.add('ghl-event', evt, { jobId: key }); } // durable enqueue; jobId dedupes; the worker must also be idempotent
  catch { return res.sendStatus(503); } // non-2xx, so HighLevel retries
  res.sendStatus(200);
});

OPTION B: PIT, no Marketplace app (help-center details not re-verified; web search budget exhausted)
- Trigger 'Customer Replied', with a Reply Channel filter (SMS or Email) and optional phrase filters. Then a 'Webhook' action (standard payload with contact fields, location, a message object 'if applicable', and custom data), or a premium 'Custom Webhook' action (custom method, body and auth headers).
- The premium pricing in the original finding ($0.01 per execution after 100 free) was NOT re-verified.
- Workflow webhooks are unsigned; a third-party repo says the workflow path 'is unsigned and cannot be made otherwise'. Put a shared secret in a header (Custom Webhook) or in the URL, and capture a real payload before coding.

Sources:
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/docs/webhook%20events/InboundMessage.md
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/docs/webhook%20events/OutboundMessage.md
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/docs/oauth/WebhookAuthentication.md
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/conversations.json
- https://github.com/GoHighLevel/highlevel-api-docs/issues/257
- https://www.npmjs.com/package/@gohighlevel/api-client
- https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide/
- https://marketplace.gohighlevel.com/docs/webhook/WebhookLogsDashboard/
- https://github.com/Exalt24/ghl-tenant-bridge/blob/main/src/lib/ghl-signature.ts
- https://help.gohighlevel.com/support/solutions/articles/155000002677-workflow-trigger-customer-replied
- https://help.gohighlevel.com/support/solutions/articles/155000003299-workflow-action-webhook-outbound-
- https://help.gohighlevel.com/support/solutions/articles/48001238167-guide-to-custom-webhook-workflow-action

## 5. SMS compliance: A2P 10DLC brand/campaign registration in HighLevel (LC Phone), required info, automatic STOP/HELP handling, and building a 'STATUS' keyword auto-reply

_Confidence: medium_

VERIFICATION STATUS: help.gohighlevel.com could not be fetched (proxy 403), and the web-search budget ran out before I reached the A2P pages. So the A2P brand and campaign specifics below are carried over from the original research, NOT re-confirmed. The STOP/START/DND facts were re-confirmed through search results that quote HighLevel's LC Phone messaging policy and DND article.

A2P 10DLC (carried over, unverified in this pass):
- US 10DLC numbers on LC Phone need an approved Brand AND an approved Campaign before sending. Unregistered sends fail with error 30034. Register in the sub-account Trust Center.
- Standard brand needs: legal name and EIN exactly as on the IRS CP-575 or 147C letter; address; entity type; authorized contact; and a live website with a Privacy Policy and Terms. If you operate under a DBA, use it consistently across the site, policies and opt-in.
- Campaign needs:
  - A use-case description that matches the real traffic: claim updates, document requests, e-sign links, replies.
  - At least 2 sample messages, each naming the brand and including opt-out language.
  - The opt-in method and the form URL. Use an unchecked, optional SMS checkbox stating message types, frequency, 'Msg & data rates may apply', 'Reply HELP for help, STOP to opt out', with links to the Privacy Policy and Terms.
  - A privacy-policy clause saying mobile opt-in data is not shared with third parties.
  - Lead generation is not allowed.
- Fees, tiers and throughput (Low Volume Standard around 6,000 segments/day, about 2,000 of them to T-Mobile; High Volume up to 600,000/day; conflicting fee figures) must be confirmed in the Trust Center.

STOP / RESUBSCRIBE (re-confirmed):
- Default opt-out keywords: STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT.
- Opting out sets PERMANENT SMS DND. The agency or location cannot revoke it (temporary DND can be).
- The contact resubscribes by texting START, YES or UNSTOP. If DND doesn't lift, HighLevel says to open a support ticket.
- Twilio-backed sends to an opted-out number fail with 21610.
- NEW RISK: users report that a STOP aimed at marketing also blocks transactional messages, because DND is per channel with no per-category choice. Claim updates by SMS stop entirely after STOP, so fall back to email for those contacts.
- Custom opt-out keywords are a feature request, not an available feature.

SMS compliance settings (auto-inserted sender ID and opt-out text on first message; the 15-day lock for new locations; the 3% opt-out suspension): carried over, unverified.

HELP (re-confirmed as undocumented): no HighLevel doc describes an automatic HELP reply for LC Phone. Build one (workflow or service). NEW RISK: LC Phone runs on Twilio, and Twilio or carrier default HELP handling might also reply. Send a test HELP before go-live to avoid double replies.

STATUS keyword (design guidance; the API parts are verified):
(1) No-code: keep the contact custom fields claim_number and claim_status in sync from Monday with PUT /contacts/{id} or upsert (Version 2021-07-28, field_value). Then build a workflow: Customer Replied, Reply Channel = SMS, Exact Match Phrase 'STATUS' (add 'Status' too, since case behavior is undocumented), then Send SMS with {{contact.claim_number}} and {{contact.claim_status}}. Works with a PIT.
(2) Service-side, using InboundMessage (Q4): the original handleInbound() is correct against the verified shapes. GET /contacts/{id} returns {contact}; customFields are {id, value}; dndSettings.SMS.status is one of active | inactive | permanent. Keep it as is, with one change: before sending, also skip when evt.messageId is one of your own stored outbound IDs.
Keep STATUS replies to the status label plus a portal link: no amounts, no bank data.

Sources:
- https://help.gohighlevel.com/support/solutions/articles/48001213941-lc-phone-messaging-policy
- https://help.gohighlevel.com/support/solutions/articles/48001214849
- https://ideas.gohighlevel.com/lcphonesystem/p/add-additional-dnd-keywords-to-sms-message
- https://ideas.gohighlevel.com/automations/p/unsubscribe-trigger-simple-when-someone-unsubscribes-we-can-tell-and-have-them-r
- https://help.gohighlevel.com/support/solutions/articles/48001186075-twilio-error-21610-the-message-from-to-pair-violates-when-sending-sms
- https://help.gohighlevel.com/support/solutions/articles/155000004539-a2p-campaign-registration-step-by-step-guide-and-faqs
- https://help.gohighlevel.com/support/solutions/articles/155000008140-registering-your-a2p-brand
- https://help.gohighlevel.com/support/solutions/articles/155000001426-a2p-opt-in-form-privacy-policy-and-terms-and-conditions-guidelines
- https://help.gohighlevel.com/support/solutions/articles/155000004684-configure-sms-compliance-settings
- https://help.gohighlevel.com/support/solutions/articles/155000002677-workflow-trigger-customer-replied
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/contacts.json

## 6. Rate limits

_Confidence: high_

API LIMITS (verified, docs/oauth/Authorization.md):
- Burst: 100 requests per 10 seconds per Marketplace app (client) per resource (Location or Company).
- Daily: 200,000 requests per day per app per resource.
- Headers:
  - X-RateLimit-Limit-Daily
  - X-RateLimit-Daily-Remaining
  - X-RateLimit-Interval-Milliseconds: the LENGTH of the burst window (e.g. 10000), not a retry-after value
  - X-RateLimit-Max
  - X-RateLimit-Remaining
- Over the limit you get HTTP 429.

SDK BEHAVIOR (verified in the README and dist/lib/HighLevel.js), with one CORRECTION: 429 retry is OPT-IN (rateLimitRetry: true or {maxRetries, baseDelayMs, maxDelayMs}) and OFF by default. When enabled:
- Burst 429 with daily remaining > 0: wait min(intervalMs, maxDelayMs = 30000), retry up to maxRetries = 3.
- Daily remaining = 0: throw GHLRateLimitError immediately.
- No headers: exponential backoff from baseDelayMs = 1000 with jitter, capped at 30s.
The SDK also retries a failed request once after a token refresh on 401.

PRIVATE INTEGRATION TOKENS (not re-verified): sandbox PITs at 25 per 10s and 10,000 per day; production PITs on 'standard' limits. Read the X-RateLimit-* headers on a live call to confirm. It's also undocumented whether a PIT shares a bucket with other apps on the same location.

MESSAGING LIMITS (carried over, not re-verified in this pass):
- LC Phone daily ramp levels (500 to 5,000+).
- 10DLC brand caps and T-Mobile daily cap (error 30023).
- Campaign MPS set by trust score.
- The 3% opt-out suspension.

UPLOAD (verified): 413 and 415 errors. The signed-URL flow allows 5MB for non-WhatsApp channels and 100MB for WhatsApp.

CODE: the original ghl() helper is consistent with the documented headers. Waiting X-RateLimit-Interval-Milliseconds (about 10s) is conservative but matches the SDK. Keep the per-location token bucket around 8 req/s (100 per 10s, with headroom). For OAuth, on 401 refresh once with grant_type=refresh_token, save the NEW refresh_token, then retry. Don't use ghl() for multipart uploads.

Sources:
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/docs/oauth/Authorization.md
- https://www.npmjs.com/package/@gohighlevel/api-client
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/conversations.json
- https://marketplace.gohighlevel.com/docs/other/rate-limits/
- https://marketplace.gohighlevel.com/docs/oauth/SandboxPIT/
- https://help.gohighlevel.com/support/solutions/articles/155000005572-messaging-ramp-progress-card
- https://help.gohighlevel.com/support/solutions/articles/155000005526-lc-phone-system-error-code-and-warning-dictionary

## 7. (Added) Settlement e-sign endpoints and docs-versioning facts relevant to the integration

_Confidence: medium_

VERIFIED:
- POST /proposals/document/send and POST /proposals/templates/send exist with Version 2021-07-28. Security is 'Location-Access' or 'Agency-Access', which accept a sub-account or agency OAuth token, or a PIT.
- These operations declare no named OAuth scope, and Scopes.md has no proposals or documents rows. Confirm the needed scope in the Marketplace app or PIT scope picker.
- The docs repo (README: 'source documentation for the GoHighLevel API V2 ... marketplace.gohighlevel.com/docs') was last changed 2026-06-19. That change added apps/v3/*.json specs using 'Version: v3', which are not linked from toc.json. The SDK 3.1.1 still defaults to Version 2023-02-21.
- Stay on the dated v2 Version values for now, and watch HighLevel's changelog for a v3 cutover.

Sources:
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/proposals.json
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/docs/oauth/Scopes.md
- https://github.com/GoHighLevel/highlevel-api-docs/tree/main/apps/v3
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/README.md
- https://www.npmjs.com/package/@gohighlevel/api-client

## Gaps and risks

- Verification limits:
- marketplace.gohighlevel.com, help.gohighlevel.com and highlevel.stoplight.io were unreachable from this environment (DNS failure or proxy CONNECT 403).
- The web-search budget ran out partway through.
- API shapes were re-verified directly against the official docs repo (cloned, HEAD 0af86a4 on 2026-06-19, with git history) and the official SDK tarball (@gohighlevel/api-client 3.1.1).
- Not re-verified in this pass: help-center facts on A2P fees, tiers and caps, SMS Compliance settings, LC Phone ramp levels, Custom Webhook premium pricing, Customer Replied filter behavior, the Reply & Forward routing effect, and sandbox PIT limits.
- Ed25519 webhook public key:
- Value: MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg= (SPKI, wrap in PEM).
- It comes from two independent secondary sources that quote the official Webhook Integration Guide, and it is well-formed. I could not read the official page itself. Confirm it there before production, and load it from config so a key rotation needs no code change.
- Legacy x-wh-signature (RSA): the sunset date was 2026-07-01 or 2026-09-01 depending on the source. Both have passed, and the SDK says the header is no longer sent. Verify only x-ghl-signature, and return 401 when it's missing.
- Replay-window bug in the original webhook code: dropping events with a timestamp older than 5 minutes (and returning 200) would silently discard legitimate retries. Non-2xx retries have been live since 2026-04-30: up to 12 with exponential backoff, and per a help article up to about 3 days for non-429 failures. Dedupe on type:messageId instead, and enqueue durably before acknowledging.
- POST /conversations/messages required fields changed in the 2026-05-01 spec sync, which added subType (object, no documented values) and status (enum) and marked them required. Earlier specs required only type and contactId. Test the minimal body. If you get a 400 asking for them, try status:'pending' and ask HighLevel support about subType.
- Upload endpoint: UploadFilesDto marks conversationId, contactId, locationId and attachmentUrls as required. You need an existing conversation (send a text first, or POST /conversations/ with conversations.write) before you can upload attachments.
- OutboundMessage 'source': the webhook doc only types it as a string (examples use 'app'). The workflow | bulk_actions | campaign | api | app enum belongs to the REST email schema. Dedupe your own API sends by stored messageId, not by source==='api'.
- Private Integration Tokens:
- No documentation shows PITs can subscribe to InboundMessage; a 2023 changelog listed it only as 'What's next'.
- The '20 PITs' cap and the '90-day' rotation guidance are unverified; the 90-day figure came from a third-party help site.
- PIT production rate limits are unspecified.
- Own-Twilio caveat: if the sub-account uses its own Twilio account rather than LC Phone, the Twilio number's inbound messaging webhook must point to https://services.leadconnectorhq.com/conversations/providers/twilio/inbound_message, or inbound SMS (and InboundMessage events) won't arrive.
- STOP scope: SMS DND is per channel with no per-category opt-out. After STOP, transactional claim updates by SMS are blocked too, and the location cannot lift permanent DND; only the contact can, by texting START, YES or UNSTOP. Fall back to email, and record the opt-out on the Monday item.
- HELP handling: no HighLevel auto-reply is documented. Twilio or carrier-level default HELP replies may or may not fire on LC Phone, so test to avoid duplicate or missing HELP responses.
- InboundMessage email schema: it types to, cc and bcc as strings but the example sends arrays, and from and subject appear only in the example. Parse defensively. The SMS payload has no sender phone number, so resolve the claimant through contactId.
- API v3 specs (Version: v3) appeared in the docs repo on 2026-06-19 but aren't published in toc.json. The official SDK still defaults to Version 2023-02-21 on every call, while the specs document 2021-04-15 and 2021-07-28. Pin the documented per-endpoint values, and add an integration test that catches version-related 400s.
- Proposals and Documents send endpoints (Version 2021-07-28) have no named OAuth scope in the specs or in Scopes.md. Confirm the scope in the app or PIT scope picker before relying on them for settlement e-signatures.
- PII: message bodies are stored in HighLevel Conversations and mirrored to Monday. Keep claim amounts and bank details out of SMS and email.
