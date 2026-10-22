# HighLevel (GoHighLevel / LeadConnector) Documents & Contracts (proposals): e-signing a settlement document with the claim number and amount filled in, and handing off to Monday once it is signed. Each finding re-checked with corrections.

## Q1. Is there a public API v2 endpoint that sends a document from a template to a contact with custom values or variables filled in? What are the exact path, body, response and scopes? If not, what are the alternatives?

_Confidence: high_

VERDICT: The core finding is CONFIRMED. There is a create-and-send-from-template endpoint, but it has NO field for variables, merge values or a document name. Merge tags resolve from the CRM records (the contact and, optionally, an opportunity).

How this was checked:
- Re-parsed the official OpenAPI repo GoHighLevel/highlevel-api-docs at commit 0af86a4 (2026-06-19). apps/proposals.json and apps/v3/proposals-v3.json are byte-identical in components and paths.
- Cross-checked against the official SDK @gohighlevel/api-client 3.1.1 (npm, published 2026-10-13). Its proposals models match field for field.
- CORRECTION: the earlier note 'last synced Sep 8 2025' is stale. The content is unchanged as of June to October 2026.

=== Endpoints ===
The Documents & Contracts API still has exactly 4 operations:
  GET  /proposals/document         operationId list-documents-contracts
  POST /proposals/document/send    operationId send-documents-contracts
  GET  /proposals/templates        operationId list-documents-contracts-templates
  POST /proposals/templates/send   operationId send-documents-contracts-template

Base URL: https://services.leadconnectorhq.com
Headers:
  Authorization: Bearer <Sub-Account OAuth token or Sub-Account Private Integration Token>
  Version: 2021-07-28   (the only allowed enum value)
  Content-Type: application/json
Security: Location-Access or Agency-Access. The spec puts NO scope strings on these operations, and docs/oauth/Scopes.md does not list them either.

=== POST /proposals/templates/send ===
Request body is SendDocumentFromPublicApiBodyDto (verified):
  required: templateId, userId, locationId, contactId
  optional: sendDocument (boolean), opportunityId (string)
  The spec gives no default for sendDocument, so always pass sendDocument: true explicitly.

200 response is SendTemplateResponseDto: { success: boolean, links: ProposalEstimateLinksDto[] }.
Each link has these required fields:
  referenceId (uuid)
  documentId (example is a UUID 'c1e87a91-...')
  recipientId
  entityName: 'contacts' | 'users'
  recipientCategory: 'recipient' | 'cc' | 'bcc'
  documentRevision
  createdBy
  deleted

CORRECTION on errors: the operation declares only 400 (BadRequestDTO { statusCode, message }). An UnauthorizedDTO { statusCode, message, error } schema exists in components but is not attached to any operation. Treat any non-2xx response generically (401, 403, 422, 429).

NEW RISK (identifiers):
- links[].documentId is shown as a UUID.
- DocumentDto in the list endpoint has BOTH _id (24-hex example) and documentId.
- A third-party live test (Sep 2026) saw two identifiers for one completed document: a 24-hex native id and a UUID 'document reference'.
- At send time, store documentId AND referenceId.
- When polling, match the stored value against DocumentDto._id, DocumentDto.documentId and DocumentDto.links[].documentId.

=== GET /proposals/templates ===
Verified query params: locationId (required), dateFrom, dateTo, type (comma-separated: proposal, estimate, contentLibrary), name, isPublicDocument, userId (required when isPublicDocument=true), limit, skip.
Response: { data: TemplateListResponseDTO[], total, traceId }.
Item fields: _id, id, name, type, locationId, version, deleted, isPublicDocument, updatedBy, createdAt, updatedAt.
ADDITION: items also have the optional fields documentCount and docFormUrl.

=== POST /proposals/document/send (re-send an existing document) ===
Body is SendDocumentDto, verified.
Required: locationId, documentId, sentBy.
Optional:
  documentName
  medium: 'link' | 'email'   (there is NO sms option)
  ccRecipients[]
  notificationSettings { sender { fromName, fromEmail }, receive { subject, templateId } }
CORRECTION: every CCRecipientItem property is REQUIRED: id (the example value is 'contactId', i.e. a CRM contact id), email, imageUrl, contactName, firstName, lastName.

=== Scopes (upgraded from 'unverified recollection' to medium confidence) ===
A third-party paste of the HighLevel scope picker, and several working OAuth codebases, use exactly these names:
  documents_contracts/list.readonly          (GET /proposals/document)
  documents_contracts/sendLink.write         (POST /proposals/document/send)
  documents_contracts_template/list.readonly (GET /proposals/templates)
  documents_contracts_template/sendLink.write (POST /proposals/templates/send)
CAVEAT: a third-party crawl of the marketplace 'Scopes' doc page spells them differently: documents_contracts/sendlink.write, documents_contracts_templates/list.readonly and documents_contracts_templates/sendlink.write (lower-case 'l', plural 'templates').
- For a Private Integration Token you tick checkboxes, so the spelling does not matter.
- For an OAuth app, copy the strings exactly from the app's scope picker and test.

=== How the claim number and amount get into the document (verified against the help-center text) ===
- Contact custom fields are inserted via the template's Merge Fields picker.
- Document custom fields pull from the PRIMARY recipient's contact record. By default that is the first-added recipient.
- Opportunity fields come from Merge Fields > Contact > Custom Fields > Opportunity Details.
- Editing a template does not change documents already sent or saved as drafts.
- Populate the fields BEFORE the send call.
- Whether POST /proposals/templates/send + opportunityId resolves opportunity merge tags is still UNDOCUMENTED. The help article describes only the workflow action.

TypeScript send function (unchanged, still valid):
const GHL='https://services.leadconnectorhq.com';
const h={Authorization:`Bearer ${process.env.GHL_TOKEN}`,Version:'2021-07-28','Content-Type':'application/json',Accept:'application/json'};
async function sendSettlement(contactId:string){
  const r=await fetch(`${GHL}/proposals/templates/send`,{method:'POST',headers:h,body:JSON.stringify({templateId:process.env.GHL_SETTLEMENT_TEMPLATE_ID,userId:process.env.GHL_SENDER_USER_ID,locationId:process.env.GHL_LOCATION_ID,contactId,sendDocument:true})});
  if(!r.ok) throw new Error(`GHL ${r.status} ${await r.text()}`);
  const j=await r.json() as {success:boolean;links:{documentId:string;referenceId:string;recipientId:string;recipientCategory:string;entityName:string}[]};
  const l=j.links.find(x=>x.recipientId===contactId&&x.recipientCategory==='recipient')??j.links[0];
  return {documentId:l?.documentId,referenceId:l?.referenceId};
}

=== Alternative: workflow action 'Send Documents & Contracts' (verified against the help-center text) ===
Settings:
- From User
- saved template
- Sending Mode: Create as Draft or Send Directly
- Channel: Email, SMS, or Email + SMS
- Assign Sender Fields To: From User or Template Owner

The contact must have an email even for SMS. Without one, the document is created but stays in Drafts. Once sent directly, the document is locked.

CORRECTION / NEW: opportunity merge fields populate only when 'the workflow uses an Opportunity-related trigger' (Pipeline Stage Changed or Opportunity Status Changed). Enrolling a contact via the API does NOT give opportunity context, so only contact fields will fill.

Ways to trigger the workflow:
(a) POST /contacts/{contactId}/workflow/{workflowId}. Verified: scope contacts.write, optional body { eventStartTime }, response { "succeded": true } (sic).
(b) POST /contacts/{contactId}/tags with { tags: [...] }. Verified: contacts.write.
(c) The Inbound Webhook trigger. CONFIRMED as an LC Premium trigger: 100 free executions per sub-account, then $0.01 per execution billed to the agency wallet unless rebilled.

Workflow downside (confirmed): you do not get the documentId back.

Sources:
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/proposals.json
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/v3/proposals-v3.json
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/docs/oauth/Scopes.md
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/contacts.json
- https://www.npmjs.com/package/@gohighlevel/api-client
- https://github.com/mitchellvandusen-cell/Flask-Webhook/blob/166ade4e9fc823c093e676afd32211f79e044a42/attached_assets/Pasted-View-Businesses-businesses-readonly-Edit-Businesses-bus_1765414776958.txt
- https://github.com/ahmedmusawir/crawl4ai-exp-project-v1/blob/aec5de5e46689f430762d662af80ef22409bf834/outputs/pages/marketplace-gohighlevel-com-docs-authorization-scopes.md
- https://github.com/bradthompsonconsulting/investor-automation-os/blob/a4c83e67b742595b99aa66520b3f6c3b4ace5fd2/docs/BOARD9_CONTRACT_INVENTORY_V1.md
- https://help.gohighlevel.com/support/solutions/articles/155000006323-documents-contracts-public-apis
- https://help.gohighlevel.com/support/solutions/articles/155000004887-workflow-action-send-documents-contracts
- https://help.gohighlevel.com/support/solutions/articles/155000004039-documents-contracts-templates-with-opportunity-custom-values
- https://help.gohighlevel.com/support/solutions/articles/155000001300-multiple-recipient-support-on-documents-contracts
- https://help.gohighlevel.com/support/solutions/articles/48001237383-how-to-use-the-inbound-webhook-workflow-premium-trigger
- https://github.com/appliancemarketingpros/ghl-documentation/tree/main/docs/Documents-%26-Contracts/Documents-and-Contracts

## Q2. How can our service learn the document was signed (webhook event names, workflow trigger, payload fields), and how do we fetch the signed PDF?

_Confidence: high_

VERDICT: CONFIRMED, with three corrections:
- the Custom Webhook action IS premium;
- the trigger also supports a 'Declined' status;
- a manual 'Mark as Completed' exists, which affects how you verify.

=== Webhook events ===
CONFIRMED: there are no Documents & Contracts / Proposal / Estimate events in the official catalog.
- docs/webhook events at commit 0af86a4 (2026-06-19) has 58 event files (AppInstall ... UserCreate). None is a document event.
- The SDK 3.1.1 WebhookManager handles only generic app webhooks: INSTALL, UNINSTALL and Ed25519 x-ghl-signature verification.
- The official 'Public APIs' help article recommends workflows that trigger on document actions.

=== Workflow trigger 'Documents & Contracts' (verified) ===
It is listed under the Payments trigger group.
Filters:
- Recipient Type: Contact or Business User
- Status: Sent, Viewed, Signed/Accepted, Completed
- Template
- Value (operators such as Greater than or Equals to)

NEW: the Decline Documents feature adds Status = Declined. A declined document is moved to Archived and can no longer be signed.

Each status change is a separate event. Selecting several statuses fires the workflow several times. Inside a workflow, document status is evaluated only at enrolment.

'Completed' means every required signer has finished. Until then the document stays under 'Waiting for others'. A third-party live test (Sep 2026) saw the last signature move the document to Completed automatically, with a populated signedDate for each recipient.
Use: Status = Completed + Template = Settlement.

NEW RISK: the UI has 'Mark as Completed' in the dashboard and editor menus. Staff can mark a document Completed without signatures. Your verification must require every signer to have hasCompleted === true AND a valid signedDate. Do not trust status alone.

=== Action: Webhook (Outbound) (verified) ===
Default payload:
- contact standard fields: first_name, last_name, full_name, email, phone, tags, address fields, timezone, date_created, contact_source, contact_type and so on;
- contact custom fields;
- a location object.
Other objects (opportunity, calendar, invoice, order, task, user, campaign) appear only when the trigger relates to them. No document fields are documented for this trigger.
Add CUSTOM DATA: contact_id={{contact.id}}, claim_number={{contact.claim_number}}, token=<secret>.

CORRECTION: the 'Custom Webhook' action IS an 'LC Premium Action': 100 free executions per sub-account once enabled, then $0.01 per execution from the agency wallet unless rebilling is on. Use the plain Webhook (Outbound) action, which is not documented as premium.

The HighLevel webhook-signature documentation (x-wh-signature RSA, now x-ghl-signature Ed25519) covers Marketplace app webhooks. Signing of workflow outbound webhooks is not documented, so keep your own shared secret and verify through the API.

=== GET /proposals/document (verified) ===
Query params:
- locationId (required)
- status: enum draft, sent, viewed, completed, accepted; comma-separated
- paymentStatus: waiting_for_payment, paid, no_payment
- limit, skip
- query (search string)
- dateFrom and dateTo, which must be sent together
There is no contactId filter. NEW: per the third-party live test, documents carry no templateId field, so you cannot filter by template via the API.

Response: { documents: DocumentDto[], total, whiteLabelBaseUrl, whiteLabelBaseUrlForInvoice }. The two URL fields are typed 'number' in the spec but the examples are URLs, so parse them leniently.

DocumentDto fields (verified): _id, documentId, locationId, name, type, deleted, isExpired, documentRevision, status, paymentStatus, locale, grandTotal { amount, currency, discountPercentage, discounts }, fillableFields[], recipients[], links[], createdAt, updatedAt.
- status and paymentStatus are typed as arrays but the examples are strings. Handle both.
- recipients[] fields: id, email, firstName, lastName, phone, phoneNumber, role ('user'|'signer'), isPrimary, signingOrder, hasCompleted, signedDate, lastViewedAt, ip, userAgent, country, imgUrl, initialsImgUrl, contactName, entityName, shareLink.
- The live test saw role = 'signer' for every recipient, so do not use role to tell parties apart. Use recipients[].id.
- 'Declined' is NOT in the API status enum. How declined or archived documents appear in the list is undocumented. Also check isExpired.

TypeScript, corrected for the identifier ambiguity and the manual-complete risk:
async function isSigned(stored:{documentId:string;referenceId?:string}, contactId:string){
  const u=new URL(`${GHL}/proposals/document`);
  u.searchParams.set('locationId',LOC); u.searchParams.set('status','completed'); u.searchParams.set('limit','50');
  const j=await (await fetch(u,{headers:h})).json();
  const ids=[stored.documentId,stored.referenceId].filter(Boolean);
  const d=j.documents.find((x:any)=>ids.includes(x._id)||ids.includes(x.documentId)||(x.links??[]).some((l:any)=>ids.includes(l.documentId)||ids.includes(l.referenceId)));
  if(!d||d.isExpired||d.deleted) return null;
  const st=Array.isArray(d.status)?d.status:[d.status];
  const signers=d.recipients.filter((r:any)=>r.role==='signer');
  const claimant=d.recipients.find((r:any)=>r.id===contactId);
  const ok=st.includes('completed')&&signers.length>0&&signers.every((r:any)=>r.hasCompleted===true&&!!r.signedDate)&&claimant?.hasCompleted===true;
  return ok?d:null;
}
Paginate with skip when total > limit.
Keep the reconciliation poller (every 10-15 minutes, status=sent,viewed,completed, over a dateFrom/dateTo window).

=== Signed PDF ===
CONFIRMED NOT AVAILABLE via the public API:
- no download endpoint;
- no PDF or file URL on DocumentDto;
- no GET /proposals/document/{id}. A third-party attempt at a single-document GET returned 401.

UI routes (verified):
- Documents & Contracts dashboard: three-dot menu > Download PDF.
- Editor menu: Download PDF.
- The contact record's Documents section: Download, View source, Copy link.

The final PDF plus signature certificate is generated 'once all Signers have signed (and any CC recipients have viewed)'.

NEW RISK for the email-capture workaround: a document-level CC recipient must be a CRM contact (ccRecipients[].id is a contact id). If that contact never 'views', final PDF generation may plausibly be held up; this is undocumented.
Prefer the settings-level Customer Notifications > CC. It accepts plain email addresses, and those addresses receive the client emails, including the 'Signed copy' email.
Whether the signed-copy email ATTACHES the PDF or only links to it is still undocumented.
Notification email templates support {{proposal.url}}, {{proposal.total}} and {{proposal.due_date}}, which suggests a link.

Workaround ranking (unchanged):
(1) staff download then upload;
(2) inbound-email capture, which needs testing;
(3) your own execution-summary PDF built from API metadata, which is evidence only;
(4) a dedicated e-sign vendor with a download API.

Sources:
- https://github.com/GoHighLevel/highlevel-api-docs/tree/main/docs/webhook%20events
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/proposals.json
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/docs/oauth/WebhookAuthentication.md
- https://www.npmjs.com/package/@gohighlevel/api-client
- https://help.gohighlevel.com/support/solutions/articles/155000001491-workflow-trigger-documents-contracts
- https://help.gohighlevel.com/support/solutions/articles/155000006323-documents-contracts-public-apis
- https://help.gohighlevel.com/support/solutions/articles/155000000594-how-to-use-documents-contracts-
- https://help.gohighlevel.com/support/solutions/articles/155000001300-multiple-recipient-support-on-documents-contracts
- https://help.gohighlevel.com/support/solutions/articles/155000001298-documents-contracts-email-templates-and-team-notifications-setup
- https://help.gohighlevel.com/support/solutions/articles/155000002526-easy-management-of-documents-and-contracts-within-contacts
- https://help.gohighlevel.com/support/solutions/articles/155000003299-workflow-action-webhook-outbound-
- https://help.gohighlevel.com/support/solutions/articles/48001238167-how-to-use-the-custom-webhook-lc-premium-workflow-action-
- https://github.com/appliancemarketingpros/ghl-documentation/blob/main/docs/Documents-%26-Contracts/Documents-and-Contracts/How%20to%20Decline%20Documents%20in%20HighLevel.md
- https://github.com/appliancemarketingpros/ghl-documentation/blob/main/docs/Workflows/Workflow-Builder/Guide%20to%20Custom%20Webhook%20Workflow%20Action.md
- https://github.com/bradthompsonconsulting/investor-automation-os/blob/a4c83e67b742595b99aa66520b3f6c3b4ace5fd2/app/src/lib/contract-execution-model.ts

## Q3. Is the signature legally an e-signature with an ESIGN/UETA audit trail? Are there plan requirements?

_Confidence: medium_

VERDICT: Mostly confirmed. One correction: HighLevel DOES make a generic official compliance claim. Plan restrictions on API access were missing and are now added.

=== What HighLevel says (verified against the help-center text) ===
- Documents & Contracts 'enables businesses to manage legally binding agreements', with e-signatures, payment collection, automated triggers and full audit tracking.
- 'Collect legally binding signatures online, with a certificate that records signer details, IP address, and timestamps.'
- 'Each signature generates a certificate with IP address, email, and timestamp.'
- The multi-recipient article: the certificate logs each signer's IP, geographic location when possible, and view and sign date/time.
- Draw vs type signatures: tracking (viewed, signed, completed) and workflow triggers work the same either way.

CORRECTION: an official help FAQ ('How to Create and Send Document or Contract Templates Automatically in a Workflow') states: 'Yes, HighLevel's e-signature process complies with major digital signature regulations for legality and auditability.'
That is a generic vendor claim:
- it names no statute;
- a search of a mirror of the help center found NO mention of ESIGN, UETA or eIDAS;
- it does not document the ESIGN 15 U.S.C. 7001(c) consumer-consent or disclosure flow;
- there is no downloadable compliance attestation.

The ideas-board posts ('Uncompliant e-signatures' and 'Upgrade GHL E-Signatures to Enterprise-Level Compliance') could NOT be re-verified in this pass because ideas.gohighlevel.com was unreachable. Treat them as reported, not confirmed.

Observed by a third party: the downloaded executed PDF carries a Signature Certificate and a document reference but NO embedded cryptographic PDF signature. Compute and store your own SHA-256 of the archived PDF.

=== Practical guidance (unchanged; not legal advice) ===
- Add an explicit e-records/e-signature consent clause with a REQUIRED checkbox or initials field.
- Make the signature field required.
- Archive the completed PDF and certificate. This is a manual download today.
- Have counsel confirm ESIGN/UETA adequacy for a release of claims. If they need a published attestation and an API-downloadable audit trail, use a dedicated e-sign vendor.

=== Plan requirements ===
NEW (official help article 'HighLevel API Documentation'):
- 'Basic API access is included with our Starter and Unlimited plans, while Advanced API access is available on our Agency Pro plan.'
- Agency Pro: 'Advanced API access, including OAuth and agency-level tokens.'
- 'Some endpoints may only be available on higher plans.'
Consequence: a Marketplace OAuth app is the Agency Pro tier. On lower plans, use a Sub-Account Private Integration Token, and test that the Documents & Contracts scopes are offered.

Other plan points:
- No official statement ties Documents & Contracts itself to a plan. It is a built-in feature under Payments.
- CORRECTION: the Custom Webhook action IS an LC Premium action, like the Inbound Webhook trigger. Agencies on any plan can enable premium features; each sub-account gets 100 free executions, then $0.01 per execution unless rebilled.
- The plain Webhook (Outbound) action is not documented as premium.

Rate limits (verified in docs/oauth/Authorization.md and the help center):
- burst: 100 requests per 10 s per Marketplace app per resource (location or company);
- daily: 200,000 per day;
- headers: X-RateLimit-Limit-Daily, X-RateLimit-Daily-Remaining, X-RateLimit-Interval-Milliseconds, X-RateLimit-Max, X-RateLimit-Remaining.
The statement that Private Integration Tokens get the same limits was not re-verified.

The HIPAA add-on price was not re-verified and is irrelevant here.

Sources:
- https://help.gohighlevel.com/support/solutions/articles/155000000594-how-to-use-documents-contracts-
- https://help.gohighlevel.com/support/solutions/articles/155000001300-multiple-recipient-support-on-documents-contracts
- https://help.gohighlevel.com/support/solutions/articles/155000001301-how-to-create-and-send-document-or-contract-templates-automatically-in-a-workflow
- https://help.gohighlevel.com/support/solutions/articles/155000005910-control-signature-types-for-documents-contracts-draw-or-type-
- https://help.gohighlevel.com/support/solutions/articles/48001060529-highlevel-api-documentation
- https://help.gohighlevel.com/support/solutions/articles/48001238167-how-to-use-the-custom-webhook-lc-premium-workflow-action-
- https://help.gohighlevel.com/support/solutions/articles/48001237383-how-to-use-the-inbound-webhook-workflow-premium-trigger
- https://github.com/appliancemarketingpros/ghl-documentation/blob/main/docs/Developer-Resources/Developer-Resources/HighLevel%20API%20Documentation.md
- https://github.com/appliancemarketingpros/ghl-documentation/blob/main/docs/Documents-%26-Contracts/Documents-and-Contracts/How%20to%20Create%20and%20Send%20Document%20or%20Contract%20Templates%20Automatically%20in%20a%20Workflow.md
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/docs/oauth/Authorization.md
- https://github.com/bradthompsonconsulting/investor-automation-os/blob/a4c83e67b742595b99aa66520b3f6c3b4ace5fd2/docs/BOARD9_CONTRACT_INVENTORY_V1.md
- https://ideas.gohighlevel.com/documents-contracts/p/uncompliant-e-signatures

## Q4. What is the most robust implementation path for: set the contact custom fields settlement_amount and claim_number, send the settlement template, and on signature fetch the PDF, upload it to the Monday file column and set status 'Settlement signed'?

_Confidence: medium_

VERDICT: The architecture is CONFIRMED: send via API, detect via a workflow webhook, verify via the API, get the PDF manually or by email capture, then write to Monday. Corrections are marked inline.

=== One-time setup in the HighLevel UI ===
1. Contact custom fields 'Claim Number' (TEXT) and 'Settlement Amount' (TEXT; send a pre-formatted '$12,500.00').
   - Creating them via the API: POST /locations/{locationId}/customFields with scope locations/customFields.write, body { name, dataType, model: 'contact' } (verified).
   - CORRECTION: do NOT use Custom Fields V2 (/custom-fields/...) for contact fields. The official spec says it 'Only supports Custom Objects and Company (Business) today'.
2. Template under Payments > Documents & Contracts > Templates.
   - Insert the fields via the Merge Fields picker.
   - Add a required claimant Signature field and a required consent checkbox or initials field.
   - Save it, then read its _id from GET /proposals/templates.
3. Customer Notifications: the signed-copy email template, plus an optional default CC (plain email addresses are allowed here) if you will try email capture.
4. Workflow 'Settlement signed > service':
   - Trigger: Documents & Contracts, Status = Completed, Template = Settlement.
   - Action: plain Webhook (Outbound), POST https://<svc>/hooks/ghl/settlement-signed, with CUSTOM DATA contact_id={{contact.id}}, claim_number={{contact.claim_number}}, token=<secret>.
   - Optionally add tag 'settlement-signed'.
   - CORRECTION: do not use 'Custom Webhook'; it is a premium action at $0.01 per execution after 100 free.
   - NEW: add a second workflow (or a second trigger) with Status = Declined, to flag the claim in Monday.
5. Sub-Account Private Integration Token (sub-account Settings > Private Integrations) with these scopes:
   - contacts.readonly and contacts.write;
   - locations/customFields.readonly;
   - Documents & Contracts list/send scopes: picker names documents_contracts/list.readonly, documents_contracts/sendLink.write, documents_contracts_template/list.readonly, documents_contracts_template/sendLink.write;
   - opportunities.write if you use per-claim opportunities.

=== Runtime flow ===
Step A. Cache custom field ids.
- GET /locations/{locationId}/customFields?model=contact (model enum: contact | opportunity | all).
- Scope: locations/customFields.readonly.
- Response: { customFields: [ { id, name, fieldKey: 'contact.xxx', dataType, model, ... } ] }.

Step B. Update the contact.
- PUT /contacts/{contactId}, scope contacts.write, body { customFields: [ { id, field_value } ] } (verified).
- The typed variants require id. Only the string variant says 'Pass either id or key'. Use id.
- Then GET /contacts/{contactId} and confirm both values persisted.
- Never include 'tags' on the PUT: it overwrites all tags.
- For per-claim deals: PUT /opportunities/{id} with customFields, scope opportunities.write (verified).

Step C. Send.
- POST /proposals/templates/send { templateId, userId, locationId, contactId, sendDocument: true, opportunityId? }.
- CORRECTION: persist BOTH links[].documentId and links[].referenceId with the Monday item id, claim number and amount, because the identifier format is ambiguous (see Q1).
- The idempotency rule is unchanged.

Step D. Signed webhook handler.
- Check the shared secret.
- Look up the claim.
- Call GET /proposals/document and match the stored ids against _id, documentId and links[].documentId.
- Require: status includes 'completed'; NOT isExpired or deleted; EVERY signer has hasCompleted === true with a valid signedDate; and the claimant's recipients[].id equals the contactId. This defends against staff using the UI 'Mark as Completed' without signatures.
- Record signedDate, ip and userAgent.
- Make the handler idempotent on documentId.
- Keep the reconciliation poller.

Step E. Get the PDF. It is not available via the API (confirmed).
(1) Staff download it (dashboard menu > Download PDF, or the contact record > Documents), then upload it to Monday. The service sets 'Settlement signed' at once and posts 'Signed PDF pending upload'.
(2) Email capture. Use the settings-level Customer Notifications CC address, NOT a document-level CC contact: CC contacts must be CRM contacts, and the final PDF is generated after any CC recipients have viewed. Test whether the signed-copy email attaches the PDF or only links to it.
- Store a SHA-256 of the PDF you archive. The GHL PDF has no embedded cryptographic signature.

Step F. Monday file upload.
- Endpoint: multipart POST https://api.monday.com/v2/file.
- Mutation, verified against the official @mondaydotcomorg/api 14.3.1 schema: add_file_to_column(item_id: ID!, column_id: String!, file: File!) returning Asset.
- Pass ids as GraphQL variables rather than string interpolation.

const form=new FormData();
form.append('query','mutation ($file: File!, $itemId: ID!, $col: String!) { add_file_to_column(item_id: $itemId, column_id: $col, file: $file) { id } }');
form.append('variables',JSON.stringify({itemId:String(itemId),col:fileColId}));
form.append('map',JSON.stringify({pdf:'variables.file'}));
form.append('pdf',new Blob([pdfBuf],{type:'application/pdf'}),`${claimNo}-settlement-signed.pdf`);
await fetch('https://api.monday.com/v2/file',{method:'POST',headers:{Authorization:process.env.MONDAY_TOKEN!,'API-Version':process.env.MONDAY_API_VERSION??'2026-01'},body:form});

- CORRECTION on API-Version: do not hard-code '2025-04'. It is likely out of support by Oct 2026. The official monday SDK 14.3.1 (published 2026-10-13) defaults to '2026-01'. Pin a currently supported version and monitor deprecations.
- NOT re-verified here (developer.monday.com unreachable): that boards:write is needed, that agent API keys cannot upload, and that uploads append rather than replace.

Step G. Status update.
- Verified signature: change_simple_column_value(board_id: ID!, item_id: ID, column_id: String!, value: String, create_labels_if_missing: Boolean).
- NEW: the 'Settlement signed' label must already exist on the status column. Otherwise pass create_labels_if_missing: true, but pre-creating the label is safer.

=== Why this path ===
Unchanged: exact matching through the stored id, the workflow webhook as the only real-time signal, API verification, and a poller.

=== Fallback ===
POST /contacts/{contactId}/workflow/{workflowId} into a workflow that runs 'Send Documents & Contracts'.
CORRECTION: in this route OPPORTUNITY merge fields will NOT populate, because they need an opportunity-related trigger. Only contact fields fill. Discover the new document via GET /proposals/document, matching recipients[].id === contactId and createdAt >= the send time.

Sources:
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/proposals.json
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/contacts.json
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/locations.json
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/opportunities.json
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/custom-fields.json
- https://help.gohighlevel.com/support/solutions/articles/155000004887-workflow-action-send-documents-contracts
- https://help.gohighlevel.com/support/solutions/articles/155000001491-workflow-trigger-documents-contracts
- https://help.gohighlevel.com/support/solutions/articles/155000003299-workflow-action-webhook-outbound-
- https://help.gohighlevel.com/support/solutions/articles/155000000594-how-to-use-documents-contracts-
- https://help.gohighlevel.com/support/solutions/articles/155000001298-documents-contracts-email-templates-and-team-notifications-setup
- https://help.gohighlevel.com/support/solutions/articles/155000004039-documents-contracts-templates-with-opportunity-custom-values
- https://www.npmjs.com/package/@mondaydotcomorg/api
- https://developer.monday.com/api-reference/reference/assets-1
- https://github.com/bradthompsonconsulting/investor-automation-os/blob/a4c83e67b742595b99aa66520b3f6c3b4ace5fd2/docs/BOARD9_CONTRACT_INVENTORY_V1.md

## How do HighLevel Custom Values and contact Custom Fields compare as template merge tags, and what is the API to update contact custom fields?

_Confidence: high_

VERDICT: CONFIRMED, with one correction about Custom Fields V2 and small type clarifications.

=== Custom Values ({{custom_values.xxx}}) ===
- One value per sub-account (location). Do NOT use them for per-claim data.
- Verified endpoints (locations.json):
  GET /locations/{locationId}/customValues (locations/customValues.readonly)
  POST /locations/{locationId}/customValues (locations/customValues.write)
  GET, PUT and DELETE /locations/{locationId}/customValues/{id}. The spec lists empty scope arrays on these, but Scopes.md maps them to the readonly/write customValues scopes.
- CustomValueSchema: { id, name, fieldKey: '{{ custom_values.custom_field }}', value, locationId }.

=== Contact Custom Fields ({{contact.<key>}}) ===
- Per contact. Documents resolve them from the PRIMARY recipient, who by default is the first-added recipient (verified).
- The right choice for one active claim per contact.
- For several concurrent claims, use opportunity custom fields:
  - update via PUT /opportunities/{id} { customFields: [...] }, scope opportunities.write (verified);
  - documented population needs an opportunity-related workflow trigger;
  - API resolution via opportunityId is unverified.

NEW: Documents & Contracts notification email templates also support document variables {{proposal.url}}, {{proposal.total}} and {{proposal.due_date}}.

=== Field discovery ===
- GET /locations/{locationId}/customFields?model=contact|opportunity|all, scope locations/customFields.readonly.
- Response: { customFields: [ { id, name, fieldKey: 'contact.pincode', placeholder, dataType: 'TEXT', position, picklistOptions, ..., model: 'contact'|'opportunity' } ] }.
- CORRECTION: Custom Fields V2 (/custom-fields/object-key/{objectKey} and the like) 'Only supports Custom Objects and Company (Business) today'. Use the /locations/{locationId}/customFields endpoints for contact and opportunity fields.

=== Updating a contact (verified) ===
PUT https://services.leadconnectorhq.com/contacts/{contactId}
Headers: Authorization: Bearer <token>, Version: 2021-07-28, Content-Type: application/json.
Scope: contacts.write.
Body: { "customFields": [ { "id": "<claimNumberFieldId>", "field_value": "HDC-000123" }, { "id": "<amountFieldId>", "field_value": "$12,500.00" } ] }

field_value types:
- TEXT and LargeText: string.
- NUMERICAL and MONETARY: the spec types them as 'object' but the examples are 100 and 100.5. Send a JSON number.
- Checkbox and MultiSelect: string[].
- FILE: object.

Notes:
- 'id' is required in the typed variants. customFieldsInputStringSchema says 'Pass either id or key'.
- 'tags' on PUT OVERWRITES all tags. Use POST or DELETE /contacts/{contactId}/tags with { tags: [...] }.
- POST /contacts/upsert (contacts.write) accepts customFields and follows the location's 'Allow Duplicate Contact' matching rules.

=== Write-back after signing (verified) ===
Template Text and Date fields can be linked to contact or document custom values. On signing, the linked fields update the record, and the dashboard offers a CSV of the filled fields. This does not retrieve the PDF.

Sources:
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/locations.json
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/contacts.json
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/opportunities.json
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/custom-fields.json
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/docs/oauth/Scopes.md
- https://help.gohighlevel.com/support/solutions/articles/155000001300-multiple-recipient-support-on-documents-contracts
- https://help.gohighlevel.com/support/solutions/articles/155000004039-documents-contracts-templates-with-opportunity-custom-values
- https://help.gohighlevel.com/support/solutions/articles/155000004040-link-custom-values-to-text-and-date-fields-documents-and-contracts
- https://help.gohighlevel.com/support/solutions/articles/155000001298-documents-contracts-email-templates-and-team-notifications-setup
- https://help.gohighlevel.com/support/solutions/articles/48001161575-how-to-use-custom-values

## What is NOT possible via the HighLevel API, and what needs a workflow or other setup in the UI?

_Confidence: high_

VERDICT: CONFIRMED against the official spec (commit 2026-06-19) and SDK 3.1.1 (2026-10-13), with additions.

=== Not available in the public v2 API ===
- Per-document variables, document name, expiry, CC or medium on POST /proposals/templates/send. documentName, medium ('link'|'email' only, no SMS), ccRecipients and notificationSettings exist only on /proposals/document/send, for an EXISTING document.
- Creating or editing templates.
- Editing document content.
- Void, cancel, decline, delete or expire.
- Reminders.
- Mark as completed.
- Get a single document by id. Only the list endpoint exists; a third party saw 401 on an attempted single GET.
- Filtering the list by contactId. NEW: also by template, since there is no templateId on documents (third-party live observation).
- Downloading the signed PDF or the certificate.
- Document webhook events. There are none in the 58-event catalog.
- SMS delivery.
- Reading 'Declined' status. NEW: 'Declined' is not in the API status enum (draft, sent, viewed, completed, accepted).

=== Needs the UI ===
- The template: merge tags, required signature and consent fields, signing order, multiple recipients, Sender fields.
- The Documents & Contracts trigger workflow + Webhook (Outbound) action, for Completed and, NEW, Declined.
- Customer and Team notification email templates and default CC addresses.
- Signature type (draw or type).
- Document Expiration ('Add Expiry'); expired documents become unsignable.
- PDF download: dashboard or editor menu > Download PDF, or contact > Documents.
- Lifecycle actions, NEW: View, Clone, Mark as Completed, Download PDF, Convert to Template, Share via Link, Move to Draft, Mark as Declined, Delete, View history.
- Optionally, the 'Send Documents & Contracts' workflow action: Create as Draft or Send Directly; Email, SMS or Email + SMS; Assign Sender Fields To.

=== Works via the API (verified) ===
- List templates and documents, with pagination via limit and skip.
- Send from a template.
- Re-send an existing document.
- Update contact custom fields (PUT /contacts/{id}).
- Update opportunity custom fields (PUT /opportunities/{id}).
- Create custom fields (POST /locations/{id}/customFields).
- Add or remove tags.
- Add a contact to, or remove it from, a workflow: POST or DELETE /contacts/{contactId}/workflow/{workflowId}, contacts.write.
- List workflows: GET /workflows/, workflows.readonly.
- Read signer metadata from the document list: status, recipients[].hasCompleted, signedDate, lastViewedAt, ip, userAgent, country, shareLink, imgUrl, and fillableFields[].value.

Sources:
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/proposals.json
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/v3/proposals-v3.json
- https://github.com/GoHighLevel/highlevel-api-docs/tree/main/docs/webhook%20events
- https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/workflows.json
- https://www.npmjs.com/package/@gohighlevel/api-client
- https://help.gohighlevel.com/support/solutions/articles/155000006323-documents-contracts-public-apis
- https://help.gohighlevel.com/support/solutions/articles/155000000594-how-to-use-documents-contracts-
- https://help.gohighlevel.com/support/solutions/articles/155000007513-send-documents-and-contracts-via-sms-in-highlevel
- https://help.gohighlevel.com/support/solutions/articles/155000001491-workflow-trigger-documents-contracts
- https://github.com/appliancemarketingpros/ghl-documentation/blob/main/docs/Documents-%26-Contracts/Documents-and-Contracts/How%20to%20Use%20Document%20Expiration%20in%20HighLevel%20Documents.md
- https://github.com/bradthompsonconsulting/investor-automation-os/blob/a4c83e67b742595b99aa66520b3f6c3b4ace5fd2/app/src/lib/contract-execution-model.ts

## Gaps and risks

- How this pass was verified: the per-turn WebSearch budget was used up before any search ran, and the proxy refused help.gohighlevel.com, marketplace.gohighlevel.com, ideas.gohighlevel.com, highlevel.stoplight.io and developer.monday.com. Sources actually used: (1) the official OpenAPI repo GoHighLevel/highlevel-api-docs at commit 0af86a4 (2026-06-19); (2) the official SDK @gohighlevel/api-client 3.1.1 (npm, 2026-10-13); (3) a GitHub mirror of HighLevel help-center articles (appliancemarketingpros/ghl-documentation, synced 2026-09-17), with each article's original help.gohighlevel.com URL cited; (4) third-party GitHub evidence: a pasted scope-picker list, a crawl of the marketplace Scopes page, and live-test notes from Sep 2026; (5) the official monday SDK @mondaydotcomorg/api 14.3.1 (2026-10-13). Re-run the help-center and ideas-board checks with direct access if they become load-bearing.
- Scope strings: the picker names (documents_contracts/list.readonly, documents_contracts/sendLink.write, documents_contracts_template/list.readonly, documents_contracts_template/sendLink.write) are corroborated only by third-party sources, and the marketplace doc page reportedly spells them 'sendlink' and 'documents_contracts_templates'. A Private Integration Token avoids the problem because you tick checkboxes. An OAuth app must copy the picker strings exactly and test.
- Identifier ambiguity: links[].documentId from templates/send is shown as a UUID. DocumentDto has both _id (24-hex) and documentId. A live third-party test saw a 24-hex id plus a UUID 'document reference' for one document. Store documentId and referenceId, and match against _id, documentId and links[] when verifying.
- Manual override: staff can use 'Mark as Completed' in the UI, which can put a document in Completed (and may fire the Completed trigger) without signatures. Verification must require every signer to have hasCompleted===true and a valid signedDate, and the claimant's recipients[].id must equal the contactId.
- The 'Declined' status (Decline Documents feature) exists in the UI and the workflow trigger, but not in the API status enum. Declined documents move to Archived and cannot be signed. Add a Status=Declined workflow to flag the claim. How declined, expired or archived documents appear in GET /proposals/document is undocumented; also check isExpired and deleted.
- Custom Webhook is an LC Premium action: 100 free executions per sub-account, then $0.01 per execution from the agency wallet unless rebilled. The Inbound Webhook trigger is premium too. Use the plain Webhook (Outbound) action, which is not documented as premium.
- Plan restriction (official help article): Basic API access on Starter and Unlimited; Advanced API access (OAuth 2.0 and agency-level tokens) on Agency Pro; 'some endpoints may only be available on higher plans'. Confirm that the agency's plan offers the Documents & Contracts scopes on a Sub-Account Private Integration Token before building.
- There is no documented way to fetch the signed PDF or certificate via the API, so fully automated archiving into the Monday file column is not possible with documented features. The final PDF is generated after all signers sign 'and any CC recipients have viewed'. A document-level CC contact used for email capture may therefore hold up completion artifacts; use the settings-level Customer Notifications CC email instead. Whether the signed-copy email attaches the PDF or links to it is untested and undocumented. The GHL PDF has no embedded cryptographic signature, so store your own SHA-256.
- Undocumented behaviour to test on a sandbox sub-account: whether POST /proposals/templates/send resolves contact and opportunity merge tags (opportunityId); what sendDocument:false produces (presumably a draft); and which document fields, if any, the outbound workflow webhook carries for the Documents & Contracts trigger.
- Fallback caveat: enrolling a contact in a 'Send Documents & Contracts' workflow via POST /contacts/{id}/workflow/{wfId} gives no opportunity context. Opportunity merge fields need an opportunity-related trigger (Pipeline Stage Changed or Opportunity Status Changed), so only contact fields will fill.
- Use /locations/{locationId}/customFields, not Custom Fields V2 (/custom-fields/...), for contact and opportunity fields. V2 currently supports only Custom Objects and Company.
- ESIGN/UETA: HighLevel's help FAQ makes a generic claim of compliance with 'major digital signature regulations', but names no statute, documents no consumer-consent or disclosure flow, and publishes no attestation. The ideas-board posts disputing compliance could not be re-verified in this pass. For a release of claims, get counsel review, or use a dedicated e-sign vendor with a published attestation and a download API.
- Monday: the add_file_to_column and change_simple_column_value signatures are confirmed from the official SDK schema. Do not hard-code API-Version 2025-04; the official SDK (Oct 2026) defaults to 2026-01. The 'Settlement signed' status label must already exist, unless you pass create_labels_if_missing. Not re-verified: that boards:write is required, that agent API keys cannot upload, and whether uploads append or replace.
- If a claimant can have several open claims, contact-level fields will be overwritten between sends. Use per-claim opportunities, update them with PUT /opportunities/{id} customFields, and verify that API resolution of opportunity merge tags works. Never send two settlements to one contact at the same time.
- The API cannot void or replace a sent document. Staff must use the UI (Mark as Declined, Move to Draft, Delete or Add Expiry), and the service must keep the superseded document ids so that a late signature on a stale amount is rejected.
