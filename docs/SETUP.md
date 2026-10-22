# Go-live runbook

Step-by-step setup of HomeDeliveryClaims.com in production. Written to be
followed in order by someone comfortable copying commands into a terminal; no
programming needed. Commands in `code blocks` are run on the server unless a step
says otherwise.

Allow a few days of calendar time: DNS, the HighLevel sending domain and especially
SMS registration (A2P 10DLC) involve waiting on third parties. Email works from day
one; text messages are switched on at the end.

**Contents**

1. [What you need](#1-what-you-need)
2. [Server (Hetzner)](#2-server-hetzner)
3. [DNS](#3-dns)
4. [Get the code and build it](#4-get-the-code-and-build-it)
5. [Monday.com](#5-mondaycom)
6. [HighLevel](#6-highlevel)
7. [Fill in .env and board.json](#7-fill-in-env-and-boardjson)
8. [Start the service and register webhooks](#8-start-the-service-and-register-webhooks)
9. [HighLevel workflows](#9-highlevel-workflows)
10. [Text messages: A2P 10DLC registration](#10-text-messages-a2p-10dlc-registration)
11. [Launch checklist](#11-launch-checklist)
12. [Day-to-day operations](#12-day-to-day-operations)

---

## 1. What you need

- The domain `homedeliveryclaims.com` and access to its DNS.
- A Hetzner Cloud account.
- Monday.com (Pro or Enterprise: URL pre-fill on forms and private boards need
  Pro or higher) with admin rights, and one spare seat for an integration user.
  **Board size:** a board holds at most 10,000 items on Pro and 100,000 on
  Enterprise, and every claim is one item. At about 1,000 claims a month a Pro
  claims board is full in roughly 10 months, after which the claim form can't
  create items and new claims stop arriving. At that volume choose Enterprise;
  on any plan, archive finished claims regularly (section 12). The plan also sets
  the daily API call allowance (about 10,000 a day on Pro, 25,000 on Enterprise).
- Email hosting for the domain (e.g. Google Workspace or Microsoft 365) with two
  mailboxes: `claims@homedeliveryclaims.com`, the contact address the site gives
  claimants for help, privacy requests and paper copies (someone must read it
  every working day), and `integration@homedeliveryclaims.com` for the Monday
  integration user (5.1). DNS records for it are in section 3.
- A HighLevel sub-account for the claims business, with Documents & Contracts and
  LC Phone (for SMS).
- Access to the GitHub repository.
- A password manager to keep the secrets you create.

Keep a scratch note (in the password manager) of these values as you collect them;
step 7 puts them all in place:

| Value | From step |
| --- | --- |
| Server IPv4 / IPv6 | 2 |
| Monday API token, integration user id | 5.1 |
| Claims board id and column ids, status labels | 5.2, 5.3 |
| Claim form embed URL | 5.4 |
| Payment form URL, pre-fill parameter names, payment board ids | 5.5 |
| Monday user ids to notify | 5.3 |
| HighLevel token, location id | 6.1 |
| Sending address | 6.3 |
| Settlement template id, HighLevel user id | 6.4 |

---

## 2. Server (Hetzner)

1. In the Hetzner Cloud console, **Create server**:
   - Location: a US region (Ashburn or Hillsboro).
   - Image: **Ubuntu 24.04**.
   - Type: CX22 or CPX21 (2 vCPU, 4 GB) is plenty.
   - Add your SSH key. Turn on **Backups** (daily server snapshots; cheap insurance
     on top of the data backups in section 12).
   - Name it `hdc-prod`.
2. **Firewalls > Create firewall**, apply it to the server. Inbound rules:
   - TCP 22 (SSH): from your own IP address(es) if you can, otherwise any.
   - TCP 80 and TCP 443: from any (Caddy needs 80 for certificates and redirects).
   - UDP 443: from any (HTTP/3; optional).
   Everything else is blocked. This cloud firewall is the one that matters: Docker
   publishes ports past the server's own `ufw`.
3. Note the server's IPv4 and IPv6 addresses.
4. Log in (`ssh root@<IPv4>`) and prepare it:
   ```sh
   apt update && apt -y upgrade
   apt -y install unattended-upgrades git
   dpkg-reconfigure -plow unattended-upgrades     # answer Yes: security updates install themselves
   timedatectl set-timezone America/New_York
   curl -fsSL https://get.docker.com | sh          # Docker Engine + Compose plugin
   docker compose version                         # should print v2.x or later
   docker version --format '{{.Server.Version}}'  # 27 or later (IPv6, section 3)
   ```
5. Optional but recommended: a non-root login for day-to-day use.
   ```sh
   adduser hdc && usermod -aG sudo,docker hdc
   rsync --archive --chown=hdc:hdc ~/.ssh /home/hdc
   ```
   Then log in as `hdc` and use `sudo` where needed.

---

## 3. DNS

At your DNS provider, for `homedeliveryclaims.com`:

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| A | `@` | server IPv4 | 300 |
| AAAA | `@` | server IPv6 | 300 |
| CNAME | `www` | `homedeliveryclaims.com.` | 300 |

Remove any old A/AAAA records for `@` and `www` (for example a parking page).
Check from the server: `dig +short homedeliveryclaims.com` and
`dig +short www.homedeliveryclaims.com` should print the new address. Caddy
requests HTTPS certificates automatically once this resolves and ports 80/443 are
open. You can raise the TTL to 3600 after launch.

**IPv6.** The AAAA record works because `deploy/docker-compose.yml` turns IPv6 on
for the service's Docker network, so Docker hands each IPv6 visitor to Caddy with
their own address, just as with IPv4. That needs Docker Engine 27 or later
(step 2.4), and section 8 has a check. Without it, Docker relays IPv6 connections
itself and every IPv6 visitor (most phones in the US) arrives as one internal
address, so they all share one set of rate limits: five login-code requests in 15
minutes from anyone on IPv6 would block the rest, and ten wrong admin passwords
would lock every IPv6 admin out. If the check fails and Docker can't be upgraded,
delete the AAAA record instead; IPv4 alone works for everyone.

Client addresses can't be faked either: Caddy ignores any `X-Forwarded-For` a
visitor sends and passes on the real one, and the app accepts that header only
because nothing but Caddy can reach it (its port is never published). Keep it
that way: don't publish port 3000 or set `trusted_proxies` in the Caddyfile.

**Email for the main domain.** The site tells claimants to write to
`claims@homedeliveryclaims.com`, so the domain needs working mail before launch.
In your email provider, add the domain, create the `claims@` and `integration@`
mailboxes (and a `dmarc@` alias for the reports below), then add the records the
provider shows:

| Type | Name | Value |
| --- | --- | --- |
| MX | `@` | the provider's mail servers |
| TXT | `@` | SPF, e.g. `v=spf1 include:_spf.google.com ~all` (the provider's include) |
| TXT or CNAME | the provider's DKIM name, e.g. `google._domainkey` | the DKIM key the provider generates; then turn DKIM signing on |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@homedeliveryclaims.com` |

There can be only one SPF record per name: if `@` already has a `v=spf1` TXT
record, add the include to it. The DMARC record also covers the HighLevel
sending subdomain from step 6.3; once its reports show your mail passing, you can
change `p=none` to `p=quarantine`. Test: from a personal address, write to
`claims@homedeliveryclaims.com`, then reply from the mailbox. Both messages should
arrive, and not in spam.

The HighLevel sending domain adds more records in step 6.3.

---

## 4. Get the code and build it

```sh
sudo mkdir -p /opt/hdc && sudo chown "$USER" /opt/hdc
git clone <repository URL> /opt/hdc
cd /opt/hdc
cp .env.example .env && chmod 600 .env
cp config/board.example.json config/board.json
cd deploy && docker compose build
```

The build takes a few minutes the first time. It produces the image `hdc-app:latest`.

**Generate the three secrets now** and paste them into `/opt/hdc/.env`
(`nano /opt/hdc/.env`):

```sh
openssl rand -base64 48     # -> APP_SECRET
openssl rand -hex 24        # -> WEBHOOK_SECRET
docker run --rm -it hdc-app:latest node dist/scripts/hash-password.js   # -> ADMIN_PASSWORD_HASH
```

The last command asks for the admin password twice (at least 12 characters; keep it
in the password manager) and prints a line starting `scrypt$`. Paste it **inside
single quotes**:

```
ADMIN_PASSWORD_HASH='scrypt$Qk3...$9xF...'
```

Without the quotes Docker treats the `$` signs as variables and the admin page
will never accept the password. Never change `APP_SECRET` after launch: it would
break every claim link already emailed.

---

## 5. Monday.com

### 5.1 Integration user and API token

The service acts in Monday as one dedicated user. Everything it posts appears
under that user's name, and its own posts are never sent back to claimants.

1. Invite a new **member** (not a guest or viewer), for example
   `integration@homedeliveryclaims.com` (it needs a mailbox to accept the invite),
   named **Claims Integration**. It uses one seat.
2. Log in as that user. Profile picture > **Developers** > **My access tokens** >
   copy the token -> `MONDAY_API_TOKEN`.
3. Profile picture > **My profile**: the address bar ends in `/users/<number>`.
   That number -> `MONDAY_INTEGRATION_USER_ID`.
4. Leave `MONDAY_SIGNING_SECRET` empty. Webhooks created with a personal token are
   not signed; the secret in the webhook URL protects them.

The token can only see boards this user can see. Add it to every board below.

### 5.2 Claims board

Use an existing claims board or create one (**Main** board type is fine; the
team works in it). Add the integration user as a board member who can edit.

Create these columns (titles are up to you; the **type** matters):

| Column | Type | `board.json` key | Notes |
| --- | --- | --- | --- |
| Item name | (built in) | | Claimant's full name, from the form. First word is used as first name. |
| Claim number | Text | `columns.claimNumber` | Written by the integration (`HDC-000123`). Don't edit. |
| Status | Status | `columns.status` | Labels below. |
| Email | Email | `columns.email` | |
| Phone | Phone | `columns.phone` | |
| Text updates | Checkbox | `columns.smsOptIn` | Ticked = claimant agreed to texts. |
| Amount claimed | Numbers | `columns.amountClaimed` | Optional. |
| Settlement amount | Numbers | `columns.settlementAmount` | Fill in **before** setting "Settlement offered". |
| Date received | Date | `columns.dateReceived` | Optional; written by the integration. |
| Claim photos | Files | `columns.intakePhotos` | The form's photo upload question. Claimant sees these. |
| Claimant uploads | Files | `columns.claimantUploads` | Files the claimant adds on their claim page land here. |
| Signed settlement | Files | `columns.signedSettlement` | Team attaches the signed PDF here. Claimant sees it. |
| Claim link | Text | `columns.portalLink` | Optional. The claimant's private link, so the team can resend it. Treat it like a password. |
| Shared documents | Files | `sharedFileColumns` | Anything placed here **appears on the claim page**. Add more shared columns if useful (e.g. "Shared photos"). |

Any other Files column (estimates, internal notes, invoices) is internal: the
integration never reads it and the claimant never sees it.

**Status labels.** Create a label for each claimant-facing stage. The suggested
set (matching `config/board.example.json`):

| Label on the board | Claimant status | What the claimant gets |
| --- | --- | --- |
| New | received | Nothing extra (the confirmation goes out when the claim arrives) |
| Under review | under_review | "Being reviewed" email/SMS |
| More info needed | more_info_needed | "We need more information" email/SMS |
| Estimate in progress | estimate_in_progress | "Preparing your estimate" |
| Settlement offered | settlement_offered | Offer email/SMS **and the settlement document for e-signature** |
| Settlement signed | settlement_signed | Payment form link (set by the integration when the signature is verified) |
| Payment sent | payment_sent | "Payment sent" |
| Closed | closed | "Claim closed" |
| Denied | denied | "Not approved" |

You may add internal labels (e.g. "Waiting on carrier"); labels not listed in
`board.json` send nothing. Label text in `board.json` must match the board
(capitals and extra spaces don't matter).

**Posting to a claimant.** Anyone on the team writes an update on the item
starting with `To claimant:`; the rest of the text is emailed (and texted, if they
opted in) with their claim link. Updates without that prefix stay internal.
Claimant replies (claim page, email, SMS) appear as updates starting
`From claimant`.

> Every item created on the claims board, by the form, by hand or by import, is
> treated as a new claim and its email address gets a confirmation. Use your own
> addresses when testing, and import historic claims only after talking to the
> developer.

### 5.3 Finding ids

- **Board id**: open the board; the address bar shows `/boards/<number>`.
- **Column ids**: turn on Developer mode once: profile picture > **monday.labs** >
  **Developer mode** > Activate. Then each column's menu (the `...` on its header)
  shows the column id (e.g. `text_mkq1a2b3`) with a copy button.
- **User ids** (for `notifyUserIds`, the people notified when a claimant writes in
  or uploads): open the person's profile; the address ends in `/users/<number>`.

### 5.4 Claim form (WorkForm)

On the claims board: **+ Add view > Form**. Questions, in this order:

1. **Name** (the item name question): "Your full name", required.
2. **Email** -> Email column, required.
3. **Phone** -> Phone column. Set the default country to US.
4. Order and delivery details (order number, delivery date, address,
   description of the damage): Short/Long text questions mapped to internal
   columns as you like.
5. **Amount claimed** (Number) -> Amount claimed.
6. **Photos** (File upload) -> **Claim photos** column.
7. **Text updates** (Checkbox) -> Text updates column. Optional, **not ticked by
   default**. Use this wording as the question (it must match the SMS registration
   in section 10 and the site's terms):

   > Yes, text me updates about my claim at the mobile number above. Message
   > frequency varies. Message and data rates may apply. Reply STOP to cancel or
   > HELP for help. Texts are not required to file a claim. SMS terms and Privacy
   > Policy: homedeliveryclaims.com/terms and homedeliveryclaims.com/privacy

Form settings:
- Require login: **off**. reCAPTCHA: **on**.
- After submission: message "Thank you. Check your email for your claim number
  and a private link to follow your claim." Don't allow editing or viewing the
  submission.
- Design: turn on **hide monday branding** (the form's design/customize panel;
  Pro or higher, on some accounts Enterprise). The site never names Monday to
  claimants. Monday doesn't always carry this setting into embedded forms, so
  check `/start-a-claim` on a phone and a computer once the site is up (launch
  checklist).
- Test uploads from an iPhone (HEIC photos, MOV video) and a large file before
  launch: Monday's form upload accepts fewer types than the claim page does.

Then **Share form > Embed**, and copy the URL inside `src="..."` of the embed code
-> `claimForm.embedUrl`. Keep its `?r=...` part.

### 5.5 Payment details board and form (finance only)

Bank details never touch the service: the claimant enters them in a Monday form on
a board only finance can open. The claim page links to that form with the claim
number and a reference code filled in.

1. Create a **Private** board, e.g. "Payment details". Board owners: finance only.
2. Columns:
   - Claim number (Text)
   - Reference (Text) (the signature that proves the link came from us)
   - Verification (Status) with labels **Verified**, **Check claim number** and
     **Duplicate submission**
   - Payment method (Status or Dropdown: Check / Direct deposit), then the
     bank and mailing-address columns finance needs.
   Restrict viewing of the bank columns to finance (column permissions).
3. **Decide whether the integration may verify submissions.** If yes (recommended),
   invite the integration user to this board. The service then reads only the
   Claim number and Reference columns of new items, sets Verification to
   "Verified", "Check claim number" (the link isn't the claim's current one, e.g.
   from before **Replace the claim link**) or "Duplicate submission" (the claim
   already has verified payment details: an update on the claim names both
   items), and marks the claim's payment step done. If the two columns are
   still empty when it first looks, it looks again over about five minutes
   before flagging the item.
   If finance prefers the integration to have no access at all, leave
   `paymentBoard` out of `board.json`; finance then checks claim numbers by hand.
4. Add a form view. Questions:
   - **Claim number**: Short text -> Claim number column. Settings: **Pre-fill**
     on, Source **URL parameter**, Parameter name `claim`.
   - **Reference**: Short text -> Reference column. Pre-fill on, URL parameter,
     Parameter name `ref`. **Hidden.**
   - Payment method, bank details (shown only for direct deposit), mailing
     address (for checks).
   The parameter names are what you type in the pre-fill setting, not the question
   titles or column ids. Use Short text for both: other question types don't
   pre-fill reliably.
5. Form settings: require login off, reCAPTCHA on, no editing or viewing of the
   submission afterwards, and **hide monday branding** in the design panel (as
   in 5.4).
6. **Share form > Copy link** -> `paymentForm.url`. The parameter names ->
   `paymentForm.claimNumberParam` (`claim`) and `paymentForm.signatureParam` (`ref`).
   Board id and the three column ids -> `paymentBoard`.

---

## 6. HighLevel

### 6.1 Private Integration Token

In the claims **sub-account** (not the agency view): **Settings > Private
Integrations > Create new integration**, name it "HomeDeliveryClaims service",
and tick these permissions:

- Contacts: view and edit (`contacts.readonly`, `contacts.write`)
- Conversation messages: view and edit (`conversations/message.readonly`,
  `conversations/message.write`), Conversations: view (`conversations.readonly`)
- Custom fields: view and edit (`locations/customFields.readonly`,
  `locations/customFields.write`)
- Documents & Contracts: list and send documents and templates
  (`documents_contracts/list.readonly`, `documents_contracts/sendLink.write`,
  `documents_contracts_template/list.readonly`,
  `documents_contracts_template/sendLink.write`)
- Locations: view (`locations.readonly`) and Users: view (`users.readonly`), used
  only by the setup check

Copy the token -> `HIGHLEVEL_API_TOKEN` (it is shown once). The sub-account id
-> `HIGHLEVEL_LOCATION_ID` (Settings > Business Profile, or the
`/location/<id>/` part of the address bar).

### 6.2 Contact custom fields

The service stores the claim number, settlement amount and claim link on the
contact so the settlement document can show them. Put `HIGHLEVEL_API_TOKEN` and
`HIGHLEVEL_LOCATION_ID` into `/opt/hdc/.env` now, then:

```sh
cd /opt/hdc/deploy
docker compose run --rm --no-deps app node dist/scripts/highlevel-setup.js fields
```

It creates **Claim Number**, **Settlement Amount** and **Portal URL** (text) if
missing.

### 6.3 Email sending domain

**Settings > Email Services** (LC Email): add a dedicated sending domain such as
`mail.homedeliveryclaims.com`, add the DNS records HighLevel shows (SPF, DKIM,
and its tracking/return-path records), and wait for it to verify. The DMARC
record for the main domain (section 3) covers this subdomain too.

- `HIGHLEVEL_EMAIL_FROM`: an address on that domain, e.g.
  `claims@mail.homedeliveryclaims.com`. Replies come back into HighLevel
  Conversations and reach Monday through the workflow in step 9.
- `HIGHLEVEL_EMAIL_FROM_NAME`: `Home Delivery Claims`.

### 6.4 Settlement agreement template

**Payments > Documents & Contracts > Templates > New template.**

- Body: the settlement and release wording **from counsel**. Insert merge fields
  with the Merge Fields picker: contact name, `{{contact.claim_number}}`,
  `{{contact.settlement_amount}}` (already formatted like `$1,250.00`), and the
  date.
- Add a **Signature** field for the claimant (required), plus a **required
  checkbox** (or initials) for consent to sign electronically, e.g. "I agree to
  sign this agreement electronically and that my electronic signature is binding."
- Optional: an expiry date for unsigned documents.
- Save. Under Documents & Contracts settings, review the customer notification
  emails (sent and signed-copy) for tone and branding.

Run the check to get the ids for `.env`:

```sh
cd /opt/hdc/deploy
docker compose run --rm --no-deps app node dist/scripts/highlevel-setup.js check
```

It lists the templates (copy the settlement one's id ->
`HIGHLEVEL_SETTLEMENT_TEMPLATE_ID`) and the users (the person the document is sent
from -> `HIGHLEVEL_USER_ID`).

Rules for the team:
- Don't send settlement documents to claimants by hand from HighLevel; set the
  Monday status to **Settlement offered** instead. A contact can only have one
  open settlement at a time.
- To withdraw an offer (amount changed), mark the document **Declined** or delete
  it in HighLevel, fix the amount on Monday, then set "Settlement offered" again.
  A signature on an old amount is not accepted.
- The signed PDF can't be fetched through HighLevel's API. When a settlement is
  signed, the service posts an update asking the team to download the PDF
  (Documents & Contracts > the document > **Download PDF**) and attach it to the
  **Signed settlement** column, where the claimant can see it.

---

## 7. Fill in .env and board.json

`/opt/hdc/.env` (`nano /opt/hdc/.env`). The file's comments explain each line.
Summary:

| Variable | Value |
| --- | --- |
| `PUBLIC_BASE_URL` | `https://homedeliveryclaims.com` |
| `APP_SECRET`, `WEBHOOK_SECRET`, `ADMIN_PASSWORD_HASH` | step 4 (hash in single quotes) |
| `ADMIN_USER` | `admin` or a name of your choice |
| `MONDAY_API_TOKEN`, `MONDAY_INTEGRATION_USER_ID` | step 5.1 |
| `MONDAY_SIGNING_SECRET` | empty |
| `HIGHLEVEL_API_TOKEN`, `HIGHLEVEL_LOCATION_ID` | step 6.1 |
| `HIGHLEVEL_EMAIL_FROM`, `HIGHLEVEL_EMAIL_FROM_NAME` | step 6.3 |
| `HIGHLEVEL_SETTLEMENT_TEMPLATE_ID`, `HIGHLEVEL_USER_ID` | step 6.4 |
| `SMS_ENABLED` | `false` until section 10 is done |

`/opt/hdc/config/board.json` (`nano /opt/hdc/config/board.json`), replacing the
example values:

| Key | Value |
| --- | --- |
| `claimsBoardId`, `claimsBoardUrl` | step 5.2 / 5.3 (the URL is the board's address, for links on the admin page) |
| `columns.*` | column ids from 5.3 (delete optional keys you don't use) |
| `sharedFileColumns` | ids of the shared Files columns |
| `statuses` | `"Label on the board": "status key"` for every claimant-facing label |
| `settlementSignedLabel` | the label the integration sets after signing (`Settlement signed`) |
| `claimForm.embedUrl` | step 5.4 |
| `paymentForm.url`, `claimNumberParam`, `signatureParam` | step 5.5 |
| `paymentBoard` | step 5.5 (board id, Claim number / Reference / Verification column ids, the two labels), or remove the whole block |
| `claimantMessagePrefix` | `To claimant:` |
| `notifyUserIds` | user ids from 5.3, as strings: `["123", "456"]` |

---

## 8. Start the service and register webhooks

```sh
cd /opt/hdc/deploy
docker compose up -d --build
docker compose ps                     # app should become "healthy" within a minute
docker compose logs --tail 50 app     # look for "Server listening"
```

If the app keeps restarting, `docker compose logs app` names the missing or
invalid setting.

Check in a browser: https://homedeliveryclaims.com (padlock shown),
https://www.homedeliveryclaims.com redirects to it, and
https://homedeliveryclaims.com/admin asks for the admin user and password.

Check that IPv6 visitors keep their own address (section 3):

```sh
docker network inspect hdc_default --format '{{.EnableIPv6}}'    # true
sudo ip6tables -t nat -S DOCKER | grep -- '--dport 443'           # a DNAT rule to Caddy
```

If the first prints `false` or the second prints nothing, upgrade Docker
(step 2.4) and run `docker compose down && docker compose up -d`, or delete the
AAAA record.

Then check the Monday configuration and register the webhooks:

```sh
docker compose exec app node dist/scripts/monday-setup.js check
docker compose exec app node dist/scripts/monday-setup.js webhooks
```

`check` must end with "All checks passed" (fix `board.json` and
`docker compose restart app` until it does). `webhooks` registers: new items,
status changes, the claimant-visible file columns, the email and phone columns
(so a corrected address reaches the claim page and HighLevel straight away) and
updates on the claims board, plus new items on the payment board. It is safe to
re-run, and must be re-run after changing `WEBHOOK_SECRET`, `PUBLIC_BASE_URL`, the
status, email or phone column or the file columns in `board.json`. The ids it
creates are kept in the data volume.

And the HighLevel check (should end "All checks passed"):

```sh
docker compose exec app node dist/scripts/highlevel-setup.js check
```

---

## 9. HighLevel workflows

HighLevel tells the service about replies and signed documents through workflows.
In the sub-account: **Automation > Workflows > Create workflow > Start from
scratch**. Build these three. In each, the action is **Webhook** (not "Custom
Webhook", which is a paid premium action):

- Method `POST`, URL
  `https://homedeliveryclaims.com/webhooks/highlevel/<WEBHOOK_SECRET>`
  (the value from `.env`; treat this URL as a password).
- Under **Custom Data**, add the keys and values exactly as listed (keys are
  lower case with underscores; values in braces are picked from the merge-field
  menu or typed as shown).
- In the workflow **Settings**, turn **Allow re-entry on**, so it fires every
  time and not just once per contact.
- **Publish** the workflow (drafts don't run).

**A. "HDC: settlement signed"**
- Trigger: **Documents & Contracts**. Filters: Status is **Completed**; Template is
  your settlement template.
- Webhook custom data:

  | Key | Value |
  | --- | --- |
  | `hdc_event` | `document_signed` |
  | `contact_id` | `{{contact.id}}` |
  | `claim_number` | `{{contact.claim_number}}` |

The service never trusts this call alone: it checks with HighLevel that every
signer really signed (staff can "Mark as completed" without signatures), then
sets the board to "Settlement signed". It also re-checks open settlements every
15 minutes in case a call is missed.

**B. "HDC: settlement declined"**
- Trigger: **Documents & Contracts**. Filters: Status is **Declined**; Template is
  the settlement template.
- Webhook custom data:

  | Key | Value |
  | --- | --- |
  | `hdc_event` | `document_declined` |
  | `contact_id` | `{{contact.id}}` |
  | `claim_number` | `{{contact.claim_number}}` |

**C. "HDC: customer replied"**
- Trigger: **Customer Replied**. Reply channel: **SMS**. Add a second trigger,
  also Customer Replied, with Reply channel **Email**. No phrase filters.
- Webhook custom data:

  | Key | Value |
  | --- | --- |
  | `hdc_event` | `inbound_message` |
  | `contact_id` | `{{contact.id}}` |
  | `claim_number` | `{{contact.claim_number}}` |
  | `message_body` | `{{message.body}}` |
  | `message_type` | `{{message.type}}` |
  | `message_id` | `{{message.id}}` |

  If `{{message.type}}` isn't offered in the merge-field menu, make two copies of
  this workflow instead, one per reply channel, and type `SMS` or `Email`
  literally as the `message_type` value. `message_id` is optional (it prevents
  duplicates when HighLevel retries).

The service handles the keywords itself: **STATUS** replies with the claim's
current status and link; **STOP** (and STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT)
is honoured by HighLevel and the service switches the claim to email only.
Don't build workflows for those.

**D. Optional: HELP reply.** The service ignores HELP. Text HELP to your number
from a test phone first: if nothing answers, add a workflow (Customer Replied,
SMS, exact match `HELP`, action Send SMS) with: "Home Delivery Claims: for help
with your claim, reply with your question or email claims@homedeliveryclaims.com.
Reply STOP to opt out." If the carrier already answers, skip it to avoid double
replies.

**Test:** reply to one of your test claim's emails. Within a minute the reply
should appear as an update on the Monday item. If not, check **/admin > Jobs**
and the workflow's execution log in HighLevel.

---

## 10. Text messages: A2P 10DLC registration

US carriers block business texting from unregistered numbers. Until this is
approved keep `SMS_ENABLED=false`: claimants who tick the box get email only.

Before you start, the website must be live with the privacy policy and terms
(including the SMS section) and the claim form showing the consent checkbox from
step 5.4.

In the sub-account: **Settings > Phone Numbers** (buy an LC Phone local number if
there isn't one), then the **Trust Center > A2P 10DLC**.

**Brand** (the business):
- Legal company name and EIN **exactly** as on the IRS letter (CP-575 or 147C).
- Business address, entity type, industry, website
  `https://homedeliveryclaims.com`, and an authorized contact person.
- If you trade under a different name, use it consistently on the site, the
  policies and the opt-in text.

**Campaign** (what you send):
- Use case: customer care / account notifications (not marketing).
- Description: "Transactional updates to customers who filed a delivery damage
  claim on homedeliveryclaims.com: claim status changes, replies from our claims
  team, requests for documents, and links to review and sign a settlement.
  Customers can text STATUS for their claim status. No marketing."
- Opt-in description: "Customers opt in on the claim form at
  https://homedeliveryclaims.com/start-a-claim by ticking an optional checkbox
  that is unticked by default. The checkbox reads: 'Yes, text me updates about my
  claim at the mobile number above. Message frequency varies. Message and data
  rates may apply. Reply STOP to cancel or HELP for help. Texts are not required
  to file a claim.' with links to the SMS terms and Privacy Policy." (Paste the
  exact wording you used in the form.)
- Privacy policy URL `https://homedeliveryclaims.com/privacy`; terms URL
  `https://homedeliveryclaims.com/terms#sms-terms`. The privacy policy must say
  mobile numbers and opt-in data are not shared with third parties for marketing
  (have counsel confirm the wording).
- Opt-out keyword STOP, help keyword HELP, message frequency "varies".
- Sample messages: copy from **/admin > Messages** (text message boxes), e.g.:
  1. "Home Delivery Claims: We received your claim HDC-000123. Track it, message us
     or add photos here: https://homedeliveryclaims.com/c/... Reply STOP to opt
     out, HELP for help."
  2. "Home Delivery Claims: Your claim HDC-000123 is now being reviewed. We'll be
     in touch if we need anything. Details: https://homedeliveryclaims.com/c/..."
  3. "Home Delivery Claims: You have a new message about claim HDC-000123. Read and
     reply here: https://homedeliveryclaims.com/c/..."
  4. "Home Delivery Claims: Your settlement offer for claim HDC-000123 is ready.
     Watch for an email with the document to review and sign."

Approval usually takes days, sometimes a few weeks; answer any rejection by fixing
exactly what it names and resubmitting.

**When the campaign is approved:**

```sh
nano /opt/hdc/.env          # SMS_ENABLED=true
cd /opt/hdc/deploy && docker compose up -d     # recreates the app with the new setting
```

Then send yourself a test: a status change on your test claim should arrive as a
text, and texting STATUS should get a reply.

---

## 11. Launch checklist

- [ ] **Counsel has reviewed** the privacy policy, terms of use (including SMS
      terms), the settlement agreement template and the e-signature consent text.
- [ ] The bracketed placeholders on the privacy and terms pages (legal entity name,
      mailing address, effective date, retention period, governing law) are filled
      in. They live in `src/web/site-info.ts`; ask the developer to update and
      redeploy.
- [ ] `monday-setup.js check` and `highlevel-setup.js check` both pass.
- [ ] `claims@homedeliveryclaims.com` receives mail sent from outside (section 3)
      and someone reads it every working day. (To show a different address on
      the site, ask the developer to change `contactEmail` in
      `src/web/site-info.ts`.)
- [ ] No monday.com logo or "Powered by monday" on `/start-a-claim` (check on a
      phone and a computer) or on the payment form (open it from a test claim
      page). Hidden branding doesn't always carry over to embedded forms.
- [ ] The IPv6 check in section 8 passes (or the AAAA record is deleted).
- [ ] **End-to-end test claim** with your own email and phone:
  - [ ] Submit the form on `/start-a-claim` with a photo and the text box ticked.
  - [ ] Confirmation email arrives; the Monday item gets its claim number, date and
        claim link.
  - [ ] Open the claim link in a new browser, request the code, sign in. Your
        photo is shown.
  - [ ] Send a message and upload a file on the claim page: an update and the file
        appear on the Monday item; the people in `notifyUserIds` get a
        notification.
  - [ ] Upload 8 or more phone photos in one go: all of them appear.
  - [ ] Post `To claimant: hello` on the item: the email arrives and the message
        shows on the claim page.
  - [ ] Reply to that email: it appears on the item.
  - [ ] Change status to Under review: email arrives; claim page shows it.
  - [ ] Put a file in a Shared documents column: it appears on the claim page.
        Put one in an internal Files column: it does not.
  - [ ] Fill in Settlement amount, set Settlement offered: the HighLevel document
        email arrives with the right claim number and amount.
  - [ ] Sign it: within a minute the board shows Settlement signed and an update
        asks for the PDF; the claim page shows the payment step.
  - [ ] Download the PDF in HighLevel, attach it to Signed settlement: it appears on
        the claim page.
  - [ ] Open the payment form from the claim page: claim number pre-filled. Submit:
        the payment board item shows **Verified**.
  - [ ] Set Payment sent, then Closed: emails arrive.
  - [ ] (Once SMS is on) Text STATUS, then STOP: status reply, then email only.
  - [ ] **/admin** shows no failed jobs.
- [ ] **Backups** scheduled (section 12) and one restore tried on a scratch
      server with the worker off and dummy tokens (section 12, "Trying a
      restore").
- [ ] An **uptime monitor** (e.g. UptimeRobot, Better Stack) checks
      `https://homedeliveryclaims.com/healthz` every few minutes and alerts you.
- [ ] Admin password, `.env` and the webhook URL are in the password manager and
      nowhere else (not in email, chat or tickets).

---

## 12. Day-to-day operations

All commands from `/opt/hdc/deploy`.

### Health and failed jobs

Open **/admin**. "Jobs failed" should be 0. If not, open it: the error says what
went wrong (e.g. a Monday column renamed, HighLevel token expired). Fix the cause,
then press **Retry**; jobs are safe to run again. Failed calls to Monday or
HighLevel retry by themselves for about two hours before they show up here.

If the account uses up Monday's daily API allowance, jobs that need Monday wait
(as pending, not failed) until a few minutes after midnight UTC, when it resets,
and then run. Rate limits that name a wait time are handled the same way.

Finished jobs are deleted after 7 days (their contents can include Monday
update text and claimant messages) and webhook delivery records after 90 days.
Failed jobs stay until retried.

### Logs

```sh
docker compose logs -f app              # follow live (Ctrl+C to stop)
docker compose logs --since 2h app      # the last two hours
docker compose logs --since 2h caddy    # HTTPS / certificate problems
```

Logs never contain message text, codes or bank details, and claim links and
the webhook secret are cut out of URLs (by the app and by Caddy's log filter).
They do contain claim numbers and Monday item ids, so still don't paste raw logs
into tickets or chat. Logs rotate automatically (about 100 MB kept).

### Backups

Everything the service owns is in the `hdc_data` Docker volume: the SQLite
database (claim numbers, messages, edited templates, the job queue), cached claim
files and the Monday webhook ids. Monday and HighLevel keep their own data.

The app makes the backup itself (`scripts/backup.ts`): a consistent copy of the
live database (safe while the app runs) plus everything else in the volume, as
one `.tar.gz`. It runs inside the container as the app's own user and writes
the archive to its output, which the host saves; so no folder needs special
ownership, and the archive gets the host's permissions.

Create `/opt/hdc-backup.sh`:

```sh
#!/bin/sh
# Nightly backup of the service's data to /opt/hdc-backups, keeping 30 days.
set -eu
umask 077    # archives hold personal data: readable by root only
STAMP=$(date -u +%Y%m%d-%H%M%S)
OUT=/opt/hdc-backups/hdc-$STAMP.tar.gz
mkdir -p /opt/hdc-backups
cd /opt/hdc/deploy
if ! docker compose exec -T app node dist/scripts/backup.js --out - > "$OUT.part" \
   || ! tar -tzf "$OUT.part" > /dev/null; then
  rm -f "$OUT.part"
  echo "$(date): backup FAILED" >&2
  exit 1
fi
mv "$OUT.part" "$OUT"
find /opt/hdc-backups -name 'hdc-*.tar.gz' -mtime +30 -delete
echo "$(date): backup written to $OUT"
```

```sh
sudo chmod 700 /opt/hdc-backup.sh
sudo /opt/hdc-backup.sh && sudo ls -lh /opt/hdc-backups     # try it once
sudo crontab -e      # add the line:  30 3 * * * /opt/hdc-backup.sh >> /var/log/hdc-backup.log 2>&1
```

Check `/var/log/hdc-backup.log` now and then: it ends with "backup written" when
all is well. The archives contain personal data: keep a copy **off the server**
(e.g. a Hetzner Storage Box with `rsync`, or encrypted with `restic`/`rclone`),
and limit who can read them.

Run without `--out -`, the script writes the archive into the data volume
instead (`/data/backups`, which the app's user can write; later backups leave it
out). The nightly script doesn't use that.

### Restoring a backup

On this server, or a new one prepared as in sections 2 to 4 with the same
`.env` and `board.json` (keep the same `APP_SECRET`, or every claim link already
sent stops working):

```sh
cd /opt/hdc/deploy
docker compose stop app
# Empty the data volume and unpack the archive into it, as the app's user.
docker compose run --rm --no-deps -T app sh -c 'cd /data && find . -mindepth 1 -delete && tar -xzf -' \
  < /opt/hdc-backups/hdc-YYYYMMDD-HHMMSS.tar.gz
docker compose run --rm --no-deps app node dist/scripts/backup.js --check
```

`--check` prints "Integrity: ok", the number of claims and the highest claim
number in the backup. **Before starting the app**, find the highest claim number
on the board (sort the Claim number column from high to low). If it is higher
than the backup's, claims were created after the backup was taken, and without
the next step new claims would get numbers already emailed to those claimants.
Move the sequence to the board's highest number (it never moves backwards, so
this is safe to run either way), then start everything:

```sh
docker compose run --rm --no-deps app node dist/scripts/backup.js --bump-sequence HDC-001234
docker compose up -d
```

After the restore:

- Claim pages show each claim as it was when the backup was taken; changes made
  on the board since then appear when that item next changes.
- Claims created after the backup aren't in the restored copy, so their claim
  links don't open. The service takes such an item in again the next time its
  status changes (or a "To claimant:" update is posted on it). It keeps the
  claim number already on the item, so the claimant's number and claim link stay
  the same, but the claimant is sent the "New claim confirmation" again. That is
  why the sequence must be moved first: an item whose number was meanwhile given
  to a new claim would get a new number instead.
- A claim link replaced (**Replace the claim link**) after the backup was taken
  works again, because the restored copy has the older link. Replace it again
  for any claim where that matters.

### Trying a restore (scratch server)

Do this once before launch and after big changes, on a separate server (or any
machine with Docker), never on production. The copy must not act on the live
board or message claimants, so it runs with the worker off and with tokens that
don't work:

1. Get the code and build the image (section 4), and copy `config/board.json`
   from production.
2. Create `.env` from production's, with these lines changed:
   ```
   WORKER_ENABLED=false
   MONDAY_API_TOKEN=restore-test
   HIGHLEVEL_API_TOKEN=restore-test
   ```
   `WORKER_ENABLED=false` keeps the copy from running the jobs that were queued
   in the backup or the 15-minute settlement check; the dummy tokens stop anything
   else from reaching Monday or HighLevel.
3. Copy an archive over (e.g. `scp`) and run the three restore commands above
   (`docker compose stop app` has nothing to stop the first time; that's fine).
   `--check` must print "Integrity: ok" and about as many claims as /admin shows
   on production.
4. Start the app alone (no Caddy: the domain points at production):
   `docker compose up -d app`. `docker compose ps` should show it healthy, and
   `docker compose logs app` should say "WORKER_ENABLED=false".
5. Delete the scratch server or the copied data and archive: they hold personal
   data.

### Updating to a new version

```sh
cd /opt/hdc
git pull
cd deploy
docker compose up -d --build
docker compose ps                 # wait for "healthy"
docker image prune -f             # remove old images
```

The restart takes a few seconds: the app first finishes the job it is running
(up to 25 seconds) so nothing is sent twice. Webhooks that arrive meanwhile are
retried by Monday and HighLevel, and queued jobs survive restarts. Take a backup
first (`sudo /opt/hdc-backup.sh`) if the release notes mention a database change.

If `docker compose up` says the network `hdc_default` needs to be recreated (the
first update after IPv6 was turned on), run `docker compose down`, then
`docker compose up -d --build` again. The data volume is kept.

After updating, run `docker compose exec app node dist/scripts/monday-setup.js webhooks`
once (it only adds what is missing): new versions can listen to more columns,
such as the email and phone columns.

### Board size: archive finished claims

Every claim is one item on the claims board, and a board holds at most 10,000
items on Pro (100,000 on Enterprise); when it is full, the claim form can't
create new claims. Once a month:

- Look at the board's item count (each group shows how many items it has).
- Archive claims that are finished (Closed or Denied) and haven't changed for a
  couple of months: filter the board on those statuses and on the last update,
  select the items, **Archive**. Monday's help ("item limit") says whether
  archived items still count toward the limit on your plan; if they do, move
  finished claims to a separate archive board instead.

What a claimant sees for an archived or moved claim: the claim page keeps
working from the service's cache. It still shows the status, messages and files
the claim had, the claimant can still sign in, and the files the service already
cached still open. But nothing about the item changes the page any more: its
status stays as it was, and new files or `To claimant:` updates aren't picked up
(archived items can't be edited, and the service only watches the claims board).
If the claimant writes on the claim page or replies to an email or text, that is
still stored, but posting it to the item may fail and show under /admin > Jobs;
restore the item (or move it back), then press **Retry**.

### Common changes

- **Message wording**: /admin > Messages. Preview, then Save. "Reset to default"
  restores the original. Takes effect at once.
- **board.json changes** (new status label, new shared Files column): edit, then
  `docker compose restart app`. If you changed the status, email or phone column
  or any Files column, also run `docker compose exec app node dist/scripts/monday-setup.js webhooks`.
- **A claim link reached the wrong person**: /admin > Claims, look up the claim,
  **Replace the claim link** (the old link, every signed-in browser and any
  payment form link already sent stop working), then **Email the claimant their
  claim link**.
- **Admin password**: generate a new hash (step 4), replace it in `.env` (single
  quotes), `docker compose up -d`.
- **Webhook secret leaked**: new `WEBHOOK_SECRET` in `.env`, `docker compose up -d`,
  re-run `monday-setup.js webhooks`, and update the URL in the three HighLevel
  workflows.
- **HighLevel or Monday token rotated**: update `.env`, `docker compose up -d`, run
  both `check` commands.
