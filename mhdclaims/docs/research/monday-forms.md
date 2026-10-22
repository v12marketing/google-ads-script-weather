# Using monday.com WorkForms as the public claim intake form and the bank-details form for HomeDeliveryClaims.com: embedding, webhooks, pre-fill, question types, restrictions, redirect, limits, and private boards (verified)

## 1. Can a WorkForm be embedded on an external website with an iframe? Are there domain allowlist settings or Enterprise-only features?

_Confidence: medium_

MOSTLY CONFIRMED, with corrections.

Embedding works. In the form view, click Share form, then pick Embed from the dropdown and copy the iframe code. A monday staff reply in the community gives exactly this path, and monday's FAQ says anyone with the link or the embed can submit without a monday.com account.

Shareable URL format: `https://forms.monday.com/forms/<FORM_TOKEN>?r=use1`. monday's own agent-toolkit (`get_form` tool description, @mondaydotcomorg/agent-toolkit 5.77.0) confirms this format. The formToken is the string between `/forms/` and `?`. The `r=` value is undocumented, so keep whatever value Share form gives you.

CORRECTION on the embed path: the `/forms/embed/<token>` path is NOT confirmed by any source I could reach. Do not hardcode it. Paste the exact snippet Share form gives you, then append pre-fill params to its `src`:
```html
<!-- replace SRC_FROM_SHARE_FORM with the src monday gives you -->
<iframe id="hdc-intake" src="SRC_FROM_SHARE_FORM&ref=UUID" width="100%" height="1400" style="border:0" loading="lazy" title="Claim form"></iframe>
```

Confirmed NOT available:
(a) No domain allowlist. A community thread asking to restrict a public form to an approved domain is still a feature request.
(b) No official JS/SDK embed, no auto-resize, and no documented postMessage height or submit events. Community threads report fixed iframe height and poor mobile behaviour, with no official answer.
(c) Branding control is limited to the design panel.

Community-reported issues (not official): CSP-blocked embeds; embeds breaking in February 2025 while direct links still worked; cookie-consent tools hiding the `forms.monday.com` iframe (allowlist the domain or link directly). A separate community report says hiding branding does not carry over to embedded views. Test this.

Plan gating:
- Password protection: Enterprise only (official settings article).
- Account pre-fill: Enterprise only (official pre-fill article).
- URL-parameter pre-fill: Pro and Enterprise (monday staff community reply plus third-party plan tables).
- Hide branding: Pro and Enterprise per a staff community post. Some third-party sources say Enterprise only.
- AI form styling as Enterprise only: NOT verified.

You are on Enterprise either way. The embed itself is not plan-gated in anything found.

Sources:
- https://support.monday.com/hc/en-us/articles/360000358700-Get-started-with-WorkForms
- https://support.monday.com/hc/en-us/articles/11040473466258-WorkForms-settings-and-permissions
- https://support.monday.com/hc/en-us/articles/26808283008146-WorkForms-pre-fill-and-form-tags-settings
- https://www.npmjs.com/package/@mondaydotcomorg/agent-toolkit (v5.77.0, get_form tool description)
- https://community.monday.com/t/can-we-limit-the-public-form-access-to-the-specified-approved-domain/84498
- https://community.monday.com/t/embedded-workforms-and-monday-com-csp/116959
- https://community.monday.com/t/form-embed-broken/110120
- https://community.monday.com/t/embedded-form-and-cookies/121335
- https://community.monday.com/t/make-js-embed-for-forms-so-they-are-responsive-on-mobile/67600
- https://community.monday.com/t/iframe-form-height-adjustment/34016
- https://community.monday.com/t/remove-monday-com-branding-on-embeded-share/22586

## 2. Does a form submission create an item that fires create_item webhooks? Are file-upload questions mapped to a Files column, and are the files attached to the item?

_Confidence: medium_

CONFIRMED, with additions.

Item creation: each submission creates a new item on the form's board. The target group is set in form settings; the API field is `features.monday.itemGroupId`.

Webhook event: `create_webhook(board_id: ID!, url: String!, event: WebhookEventType!, config: JSON)`, verified in the official SDK's generated types. `create_item` means "An item was created on board". No official page says form-created items fire it, but community and staff threads treat them as normal creations. The board fires `create_item` for EVERY creation path (UI, API, automations, imports). Filter in your handler, for example with a hidden pre-filled `source=webform` question, or by `groupId`.

Payload: the official support sample has `event.type: "create_pulse"` plus `pulseId`, `pulseName`, `boardId`, `groupId`, `triggerUuid`, and `columnValues`. A developer-community staff answer confirms create events carry only the item ID and name, with `columnValues` effectively empty. Always fetch the item.

Gotchas (community, not official):
- Values set at creation do not fire `change_column_value` for status, dropdown, or people columns (staff statement). Other reports say the same for form-set values generally.
- Columns that the WorkForms builder adds may not fire column webhooks.

Challenge: monday POSTs `{"challenge":"..."}`, and you echo the same JSON back.

Auth:
- Only webhooks created with an integration-app (OAuth or app) token get an `Authorization` JWT signed with the app's Signing Secret. Webhooks created with a personal token or the UI recipe have no header.
- The challenge request itself is NOT signed, so skip verification for it.

Create the webhook (omit `config` for `create_item`):
```graphql
mutation { create_webhook(board_id: 1234567890, url: "https://svc.homedeliveryclaims.com/monday/webhook", event: create_item) { id board_id event } }
```
The 255-character `url` limit comes only from a third-party client library's docs. It was not confirmed in monday's own docs.

Upload file question: it maps to a Files column (`File` question type). Files land as monday assets in the item's Files column.

Fetch query (field names verified in official SDK types: `FileValue.files: [FileValueItem]`, `FileValueItem = FileAssetValue | FileDocValue | FileLinkValue`, `Asset.public_url` documented as "valid for 1 hour"):
```graphql
query ($ids: [ID!]) { items(ids: $ids) { id name group { id } column_values { id type text value ... on FileValue { files { ... on FileAssetValue { asset_id name is_image asset { id name file_extension file_size public_url url } } } } } } }
```
If the Files column comes back empty right after `create_item`, re-fetch with backoff. A Make.com thread reports automations firing before form fields were populated.

Idempotency: dedupe on `pulseId`/`triggerUuid`. Community reports describe duplicate deliveries and retries; official docs describe roughly 30 minutes of retries on non-200 for app endpoints. ACK with 200 fast and process async, as in the original handler sketch.

Caveat (secondhand, unconfirmed): if the account-level file upload/download permission is off, file questions cannot be submitted.

Sources:
- https://support.monday.com/hc/en-us/articles/360003540679-Webhook-integration
- https://developer.monday.com/api-reference/reference/webhooks
- https://developer.monday.com/api-reference/docs/webhooks
- https://developer.monday.com/apps/docs/authorization-header
- https://developer-community.monday.com/api-apps-framework-4/create-item-webhook-returns-empty-columnvalues-3952
- https://developer-community.monday.com/product-updates/changes-for-the-creation-of-an-item-by-an-integration-or-automation-3104
- https://developer-community.monday.com/api-apps-framework-4/columns-created-through-workforms-do-not-trigger-webhook-1267
- https://github.com/mondaycom/monday-graphql-api (packages/api/lib/generated/sdk.ts: Asset.public_url 'valid for 1 hour', FileValue, WebhookEventType, MutationCreate_WebhookArgs)
- https://support.monday.com/hc/en-us/articles/22630036771986-WorkForms-question-types
- https://support.monday.com/hc/en-us/articles/360000597900-The-Files-Column
- https://community.make.com/t/send-lead-information-from-smartlead-ai-to-monday-com/24780

## 3. Pre-filling form fields through URL query params: exact syntax, plan tier, hidden pre-filled fields, pre-filling a text column (claim number), and special characters

_Confidence: high_

CONFIRMED, with two corrections.

Setup in the UI: open the question's settings, turn on Pre-fill value, set Source = URL parameter, and type a Parameter name. Then append `<parameterName>=<value>` to the form URL.

Plans:
- URL parameter: Pro and Enterprise (monday staff community reply).
- Account: Enterprise only (official article).

CORRECTION 1: the parameter name is NOT the question's title and NOT a column ID. It is the free-text "Parameter name" you type. In the API this is `settings.prefill.lookup`. The old `&<columnId>=value` trick is unofficial.

Hidden plus pre-filled: CONFIRMED. monday's official CSAT-on-monday-service guide (Enterprise template) opens a hidden "Name" question, turns on prefill with Source = URL parameter and Parameter = "Name", and builds the link in an email automation with an item placeholder. `FormQuestion.visible` exists in the API.

API schema (verified in monday's official agent-toolkit, which targets API 2026-10):
- `settings.prefill { enabled: Boolean!, source: FormQuestionPrefillSources, lookup: String }`.
- GraphQL enum values are `Account` and `QueryParam`.
- Account lookups are `Email`, `Name`, `Title`, `Phone`, `FirstName`, `LastName`, `Location`, `Timezone`, `ManagerName`.
- Related: `settings.default_answer` (static default) exists for ShortText/LongText/Name/Link only.

CORRECTION 2: on `update_form_question`, the `question` input must ALWAYS include `type`. The question type cannot be changed, so resend the existing type. Corrected mutation:
```graphql
mutation { update_form_question(formToken: "FORM_TOKEN", questionId: "QUESTION_ID", question: { type: ShortText, visible: false, settings: { prefill: { enabled: true, source: QueryParam, lookup: "claim" } } }) { id type visible settings { prefill { enabled source lookup } } } }
```
For select questions, an update must resend ALL options. Omitted options are deleted.

Claim number recipe:
1. Add a Short text question "Claim number". It maps to a Text column.
2. Turn on Pre-fill: Source = URL parameter, Parameter = `claim`.
3. Hide the question.
4. Link to `https://forms.monday.com/forms/<TOKEN>?r=use1&claim=HDC-000123`.

The TypeScript `URL`/`URLSearchParams` builder in the original is fine. `HDC-000123` needs no encoding. For other values, percent-encode them; a community report says both `+` and `%20` work for spaces.

Supported question types for URL pre-fill: NOT confirmed officially.
- A monday staff community reply says "only supports text" for URL params (possibly outdated).
- Third-party lists disagree: Short/Long text, Number, Email, Phone, Link, and Dropdown in one; Single/Multi select and Country in another.
- Use Short text for anything critical, and test any other type.

Tampering risk stands: anyone can edit the URL.

Sources:
- https://support.monday.com/hc/en-us/articles/26808283008146-WorkForms-pre-fill-and-form-tags-settings
- https://support.monday.com/hc/en-us/articles/27016625600274-CSAT-surveys-on-monday-service
- https://www.npmjs.com/package/@mondaydotcomorg/agent-toolkit (v5.77.0: QuestionSettings fragment, FormQuestionPrefillSources enum, form_questions_editor descriptions)
- https://developer.monday.com/api-reference/reference/forms-other-types
- https://community.monday.com/t/heres-how-to-pre-fill-column-data-within-workform-url/112138
- https://community.monday.com/t/url-auto-fill-special-fields-in-forms/95887/4
- https://community.monday.com/t/solution-for-using-url-parameters-to-pre-fill-a-text-field/95843

## 4. Can a form set Checkbox (SMS opt-in), Phone, Email, and Numbers columns? Can submissions be restricted (CAPTCHA, login off)?

_Confidence: high_

CONFIRMED, with corrections.

Column mapping:
- `Boolean` maps to a Checkbox column. `settings.checkedByDefault` controls the starting state; leave it false for TCPA consent.
- `Phone` maps to a Phone column. CORRECTION: `settings.prefixPredefined { enabled, prefix: "US" }` sets a DEFAULT country code. No source says it restricts input to one region. `prefixAutofilled` auto-detects the prefix instead. Validate E.164/US numbers in your service.
- `Email` maps to an Email column.
- `Number` maps to a Numbers column.
- `ShortText` maps to Text, and `File` maps to Files.

The `FormQuestionType` enum in the official toolkit codegen also has `DISPLAY_TEXT`, `HOUR`, and `PAGE_BLOCK`, in addition to the 21 types listed in the original. Type cannot be changed after creation (confirmed).

The People question is available only on login-restricted forms. This was not re-verified; it is irrelevant for the public form either way.

Restriction options (FormFeaturesInput, verified in the toolkit):
- `reCaptchaChallenge: Boolean`.
- `requireLogin { enabled, redirectToLogin }`. Keep this OFF for public forms.
- `responseLimit { enabled, limit }`. This is a global total.
- `closeDate { enabled, date }`, where `date` is an ISO timestamp.
- `draftSubmission { enabled }`.
- `preSubmissionView { enabled, title, description, startButton { text } }`.
- `monday { itemGroupId, includeNameQuestion, includeUpdateQuestion, syncQuestionAndColumnsTitles, allow_create_item }`.
- `ai_translate { enabled }`.

CORRECTION on password: `features.password.enabled` can ONLY be set to false. To turn protection on, call:
```graphql
mutation { set_form_password(formToken: "T", input: { password: "..." }) { id } }
```
Password protection is Enterprise only.

CORRECTION on anonymous: `is_anonymous` is a TOP-LEVEL field of `UpdateFormSettingsInput`, i.e. `settings: { features: {...}, is_anonymous: true }`. There is no `appearance.isAnonymous`. The read field is `Form.isAnonymous`.

The CAPTCHA mutation in the original is valid:
```graphql
mutation { update_form_settings(formToken: "FORM_TOKEN", settings: { features: { reCaptchaChallenge: true, requireLogin: { enabled: false } } }) { features { reCaptchaChallenge requireLogin { enabled } } } }
```

Not possible natively (no source shows otherwise):
- Per-IP or per-email rate limits.
- Dedupe by claim number.
- Server-side validation or callouts during submit.
- Domain-restricted embedding.

Dedupe in your service, e.g. with `items_page_by_column_values`, which exists as a root query.

Sources:
- https://support.monday.com/hc/en-us/articles/22630036771986-WorkForms-question-types
- https://support.monday.com/hc/en-us/articles/11040473466258-WorkForms-settings-and-permissions
- https://www.npmjs.com/package/@mondaydotcomorg/agent-toolkit (v5.77.0: FormFeatures fragment, FormFeaturesInput zod schema, setFormPassword, updateFormFeatures with is_anonymous)
- https://developer.monday.com/api-reference/reference/forms-other-types
- https://developer.monday.com/api-reference/reference/form
- https://developer.monday.com/api-reference/changelog/new-ability-to-create-update-and-delete-workforms

## 5. Can we redirect after submission to a custom URL (with the item ID or a submitted value) or show a custom thank-you message?

_Confidence: high_

CONFIRMED (static redirect only).

API shape, verified in the official toolkit's FormFeatures fragment: `features.afterSubmissionView { title, description, redirectAfterSubmission { enabled, redirectUrl }, allowResubmit, showSuccessImage, allowEditSubmission, allowViewSubmission }`. The mutation in the original is valid. There is one static `redirectUrl` with no placeholders and no merge fields for the item ID or answers, and a community feature request for this remains open.

UI path: After submission, toggle Redirect URL, then Set URL. A third-party blog also documents it.

Plan gating of the redirect: unverified. One third-party table claims it is unavailable, but you are on Enterprise.

CORRECTIONS / downgrades:
(a) "External submitters get up to 10 edits per submission" comes only from a competitor vendor blog (TaskRhino/BoardBridge). It is NOT confirmed by monday docs.
(b) Plan gating for Response editing conflicts across sources (Pro+ vs Enterprise only). It is fine on Enterprise.
(c) For the bank form, keep `allowEditSubmission` and `allowViewSubmission` false.

The correlation-ref workaround stands as a design pattern. Whether the redirect navigates the iframe or the top window is undocumented, so test both.
- If it navigates the iframe and the redirect page is on homedeliveryclaims.com, it is same-origin with the parent, so `window.parent.postMessage` or direct access works.
- If it navigates the top window, the parent page is simply replaced. Put the `ref` in the redirect URL yourself before rendering the iframe; monday will not append it.

Sources:
- https://www.npmjs.com/package/@mondaydotcomorg/agent-toolkit (v5.77.0: afterSubmissionView / redirectAfterSubmission fields)
- https://support.monday.com/hc/en-us/articles/11040473466258-WorkForms-settings-and-permissions
- https://developer.monday.com/api-reference/reference/forms-other-types
- https://community.monday.com/t/using-monday-forms-to-pass-parameters-in-the-url/7555
- https://www.taskrhino.ca/blog/monday-com-form-redirect-after-submission/
- https://www.taskrhino.ca/blog/monday-com-edit-form-responses-without-enterprise/

## 6. Limits: max file size per upload, max number of files, submission limits

_Confidence: medium_

MOSTLY CONFIRMED, with additions.

File size:
- The Files Column help article says 500MB per individual file. An older "How to manage files" article phrases it as per item.
- monday publishes no WorkForms-specific size limit. One community user only says "500MB I believe", and a feature request complains WorkForms limits are "restrictive".
- Expect large uploads from phones to fail late. A feature request asks for a pre-submit size warning.

NEW RISK, file TYPES: a community post quotes a monday support ticket saying WorkForms no longer accepts .docx. It lists the accepted types as JPEG, Word/Doc, PDF, XLSX, CSV, GIF, MP4, SVG, TXT, and AI; PNG, HEIC, and MOV are not named. This is unofficial, but it matters for delivery-damage photos (iPhone HEIC, MOV video). Test every expected type before launch. There is no native way to restrict or allow types or set file-count caps (feature requests; third-party Easyform can).

Number of files: no documented per-question cap. A 2022 staff reply mentioned about 20k files per board, which may be outdated.

Submissions:
- No per-form quota.
- `responseLimit` is an optional global cap.
- Board item limit: 100,000 items per board on Enterprise and 10,000 on other plans, per the official item-limits article and the mondayDB 2.0 article. A 1M CRM tier is in beta. The developer "limits" page still says 10,000, which is outdated. Archive or move processed claims.

Automation and integration quotas (official), each counted separately per month:
- Standard: 250 + 250.
- Pro: 25,000 + 25,000.
- Enterprise: 250,000 + 250,000.
Every automation fired per submission consumes actions. API webhooks do not count as integration actions; this is per common understanding and was not re-verified.

Sources:
- https://support.monday.com/hc/en-us/articles/360000597900-The-Files-Column
- https://support.monday.com/hc/en-us/articles/115005339505-How-to-manage-files-in-monday-com
- https://support.monday.com/hc/en-us/articles/4404058746642-Item-and-subitem-limits-per-board
- https://support.monday.com/hc/en-us/articles/20705455822354-mondayDB-2-0
- https://support.monday.com/hc/en-us/articles/360002826680
- https://support.monday.com/hc/en-us/articles/360017556179
- https://community.monday.com/t/higher-upload-limits-on-workforms/121478
- https://community.monday.com/t/alert-workforms-user-if-file-upload-is-too-large-prior-to-submission/103974
- https://community.monday.com/t/error-unable-to-upload-files-to-forms-anymore-anyone-else-seeing-this/113399
- https://community.monday.com/t/forms-only-allow-customers-to-upload-specific-file-type/66969
- https://developer-community.monday.com/api-apps-framework-4/need-help-to-know-how-we-can-download-file-content-using-api-and-how-many-maximum-number-of-files-can-be-added-to-column-1696

## 7. Private boards: can a form on a private board accept public submissions, and who can see the items? Is the main/shareable/private board type relevant to restricting bank data to finance?

_Confidence: medium_

LARGELY CONFIRMED.

Board types (official):
- Main: visible to the whole account (team members).
- Shareable: Standard+; guests can be invited.
- Private: Pro and Enterprise; only the creator and invited members/viewers, never guests.

Use PRIVATE for bank details.

Form on a private board: still not explicitly documented. New supporting evidence: the official `create_form` mutation takes a `board_kind: BoardKind` argument (verified in monday's toolkit), so the API supports creating a form whose backing board is private. Its arguments are:
- `destination_workspace_id` (required)
- `destination_folder_id` / `destination_folder_name`
- `board_kind`
- `destination_name`
- `board_owner_ids` / `board_owner_team_ids`
- `board_subscriber_ids` / `board_subscriber_teams_ids`
It returns `{ boardId, token }`.

Whether anyone can submit is governed by the form's own sharing settings (`requireLogin` off means anyone with the link can submit). Still do one logged-out test submission.

Submitters get no board access. Turn off view and edit-response for the bank form.

Visibility controls (official):
- Enterprise board roles: Owner, Editor, Contributor, Assigned contributor, Viewer. Owners bypass board permissions.
- Item-viewing limits apply to all non-owner roles at once (community).
- Column permissions: restrict view OR edit, not both on one column. Board owners are always exempt. Most help pages say Pro+; one says Enterprise.

Keep the bank board's owners to finance only.

Integration implications stand:
- An API token only sees what its user sees.
- The integration user must be subscribed to the private board to read items or create webhooks on it. Consider not subscribing the agency service at all.
- Do not mirror or connect bank columns elsewhere.
- Keep bank values out of automation emails.

Sources:
- https://support.monday.com/hc/en-us/articles/115005311105-The-difference-between-board-types
- https://support.monday.com/hc/en-us/articles/115005310185-Private-Boards
- https://support.monday.com/hc/en-us/articles/31152393208466-Board-permissions-on-Enterprise
- https://support.monday.com/hc/en-us/articles/360011926640-Column-permissions
- https://support.monday.com/hc/en-us/articles/360019222479-Permissions-on-monday-com
- https://support.monday.com/hc/en-us/articles/11040473466258-WorkForms-settings-and-permissions
- https://developer.monday.com/api-reference/docs/create-form
- https://www.npmjs.com/package/@mondaydotcomorg/agent-toolkit (v5.77.0: createForm mutation with board_kind)

## API access to WorkForms (managing forms in code) and version notes

_Confidence: high_

CONFIRMED (confidence raised), with corrections.

The official changelog entry "New ability to create, update and delete WorkForms" (2025-10) and "New ability to read WorkForms" confirm GraphQL support. monday's own agent-toolkit (npm @mondaydotcomorg/agent-toolkit 5.77.0, published 2026-10-20) pins `API-Version 2026-10` and sends these exact operations to `https://api.monday.com/v2`. The "no direct GraphQL equivalent" text on the Platform MCP pages refers to the action-based MCP tool, not to missing mutations. The GraphQL basics page claim that WorkForms are unsupported is stale.

Verified operations (2026-10):
- `form(formToken: String!)`. Fields: id, token, title, description, active, ownerId, type, builtWithAI, isAnonymous, questions, features, appearance, accessibility, tags.
- `create_form(destination_workspace_id: ID!, ...)` returns `{ boardId token }`.
- `update_form(formToken, input: UpdateFormInput)` for title, description, and question order via `questions: [QuestionOrderInput!]`.
- `update_form_settings(formToken, settings: UpdateFormSettingsInput)` with `{ features, appearance, accessibility, is_anonymous }`.
- `create_form_question(formToken, question: CreateQuestionInput!)`.
- `update_form_question(formToken, questionId, question: UpdateQuestionInput!)`. Always include `type`.
- CORRECTION: deleting a question is `delete_question(formToken, questionId)`, NOT `delete_form_question`.
- `set_form_password(formToken, input: { password })`.
- `shorten_form_url(formToken)`.
- `activate_form(formToken)` / `deactivate_form(formToken)`.
- `create_form_tag(formToken, tag: { name })` / `delete_form_tag(formToken, tagId)`.
- `FormTag` fields in the 2026-10 toolkit: `id, name, columnId`. There is no `value` and no `update_form_tag` used, consistent with the claimed 2026-10 removals. The release-note text itself was not retrieved.
- `FormLayout` is now queried as `layout { type alignment direction }`, consistent with removal of `format`.

Versioning: monday's versioning schedule lists 2026-10 as current from Oct 1, 2026, with 2027-01 as RC (current Jan 15, 2027).

Related 2026-10 breaking changes that may hit the integration:
- `showIfRules` replaced by `show_if_rules`.
- Legacy User fields (`is_admin`, `is_guest`, `enabled`, `is_pending`) removed.
- `users` now defaults to 200 results (max 1000).

NOTE: the official JS SDK @mondaydotcomorg/api 14.3.1 still DEFAULTS to `2026-01`. Pass the version explicitly.

The inspection query in the original is valid. Headers: `Authorization: <token>`, `API-Version: 2026-10`, `Content-Type: application/json`.

Also found: a `create_form_submission(form_token, answers: [FormAnswerInput!]!, form_timezone_offset: Int!, password, tags)` mutation exists, but the official toolkit calls it ONLY with API version `dev`. It is not production-stable, so do not build on it.

Sources:
- https://developer.monday.com/api-reference/changelog/new-ability-to-create-update-and-delete-workforms
- https://developer.monday.com/api-reference/changelog/new-ability-to-read-workforms
- https://developer.monday.com/api-reference/reference/form
- https://developer.monday.com/api-reference/reference/forms-other-types
- https://developer.monday.com/api-reference/docs/api-versioning
- https://developer.monday.com/api-reference/docs/release-notes
- https://www.npmjs.com/package/@mondaydotcomorg/agent-toolkit (v5.77.0 dist/esm/core/index.js: workforms GraphQL documents, k="2026-10")
- https://github.com/mondaycom/monday-graphql-api (packages/api/lib/constants/index.ts: CURRENT_VERSION='2026-01')
- https://github.com/PostHog/posthog/pull/119191

## Gaps and risks

- How this was checked: support.monday.com, developer.monday.com, community.monday.com and api.monday.com were unreachable from this sandbox (DNS failure in WebFetch, proxy 403 in curl). Exact GraphQL names were therefore checked against monday's own published code: npm @mondaydotcomorg/agent-toolkit 5.77.0 (2026-10-20, pins API 2026-10) and github.com/mondaycom/monday-graphql-api (SDK generated types). Other claims rest on search-engine excerpts of the official pages. Run one introspection call against API-Version 2026-10 before coding.
- Corrections the implementer must apply. (1) Delete a question with `delete_question`, not `delete_form_question`. (2) `UpdateQuestionInput` must always include `type`. (3) To enable a password, use `set_form_password(formToken, input:{password})`; `features.password.enabled` only accepts false. (4) `is_anonymous` is a top-level field of `UpdateFormSettingsInput`, not under appearance. (5) The pre-fill parameter name is the free-text `lookup`, not the question title or column ID. (6) The phone `prefixPredefined` sets a default country code and does not restrict input.
- WorkForms may reject some file types. A secondhand support quote says .docx is no longer accepted, and PNG, HEIC and MOV are not on its list. Claimants will often upload iPhone HEIC photos and MOV videos. Test every expected type, and the 500MB size limit, from a real phone before launch.
- Which question types accept URL pre-fill is not officially confirmed. A monday staff community reply says only text works. Use Short text for the claim number, the ref and the signature.
- Not officially documented (only community or third-party sources): whether the redirect navigates the iframe or the top window; whether hidden branding carries over to embeds; whether the Files column is populated at the moment create_item fires. Re-fetch with backoff if the Files column is empty.
- create_item fires for every way an item is created (UI, API, automations, imports, duplicates). Filter form submissions with a hidden pre-filled marker question, or by target group (features.monday.itemGroupId).
- Webhook delivery: auth headers are present only on webhooks created with an app token, and the challenge request is unsigned. Retries and duplicate deliveries are reported, so make the handler idempotent on pulseId/triggerUuid. The 255-character URL limit was not confirmed in monday's own docs.
- Pre-fill tampering: anyone can edit a URL-supplied claim number. Keep the HMAC 'sig' hidden field or one-time tokens, and validate them server-side.
- The official JS SDK (@mondaydotcomorg/api 14.3.1) defaults to API version 2026-01, while 2026-10 is current and changes form tags, layout and User fields. Pin API-Version explicitly in every client.
- `create_form_submission` is a mutation for submitting a form through the API, but monday's toolkit calls it only on the 'dev' API version. Do not rely on it for a native-form-to-WorkForm bridge. The safer alternative remains a native site form that calls create_item and add_file_to_column, which also returns the item ID synchronously.
- Plan-gating conflicts on non-blocking features (hide branding, response editing, column permissions, redirect). All are available on Enterprise. If the account is ever downgraded, URL pre-fill (Pro+) and password protection (Enterprise) would break first.
- Not verified at all: the claim that external submitters get 10 response edits (comes only from a vendor blog); that AI form styling is Enterprise-only; that the People question requires login; that an account-level file-permission setting blocks forms with a file question.
- Item limit: 100k items per board on Enterprise per the support article; the developer limits page still says 10k. Plan archiving. Automation quota is 250k actions per month for automations and 250k for integrations on Enterprise.
