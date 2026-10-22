# Settlement agreement — placeholder for the HighLevel template

**DRAFT STRUCTURE ONLY. Not legal advice. Counsel replaces every `[BRACKETED]`
item and the wording of each section before this is used.**

Build this in HighLevel under **Payments > Documents & Contracts > Templates**
(see `docs/SETUP.md` section 6.4). The `{{...}}` items are HighLevel merge fields:
insert them with the Merge Fields picker so they fill in automatically. The
service sets `claim_number` and `settlement_amount` on the contact just before it
sends the document.

---

## Settlement Agreement and Release

**Claim number:** {{contact.claim_number}}
**Claimant:** {{contact.name}}
**Settlement amount:** {{contact.settlement_amount}}
**Date:** {{right_now.month_name}} {{right_now.day}}, {{right_now.year}}

This agreement is between {{contact.name}} ("you") and
**[CLAIMS ENTITY LEGAL NAME]** ("we"), about the claim above for damage to property
delivered by **[DELIVERY COMPANY NAME]** on or about **[DELIVERY DATE — or remove]**.

### 1. Payment

**[COUNSEL: payment terms — e.g. that we will pay the settlement amount by mailed
check or direct deposit, as you choose on the payment form after signing, within
[NUMBER] business days of receiving your payment details.]**

### 2. Release

**[COUNSEL: release wording — what claims are released, by whom, against whom
(the claims entity, the delivery company, their affiliates, etc.), and any
carve-outs.]**

### 3. No admission of liability

**[COUNSEL: wording, or remove.]**

### 4. Other terms

**[COUNSEL: entire agreement, governing law ([STATE]), severability, any
confidentiality, and anything else required.]**

### 5. Electronic signature

**[COUNSEL: confirm this consent wording.]** I agree to sign this agreement
electronically. I understand that my electronic signature has the same effect as
a handwritten signature, and that I can ask for a paper copy by contacting
**[CONTACT EMAIL]**.

- [ ] *(required checkbox)* I agree to sign electronically.

**Claimant signature:** *(HighLevel Signature field, required)*

---

## Notes for whoever builds the template

- Make the signature field and the consent checkbox **required**.
- The signer must be the contact the document is sent to (the claimant). Don't
  add other signers; the service only accepts the document as signed when every
  signer has signed.
- Optional: set an expiry date so unsigned offers lapse.
- After saving, run `highlevel-setup.js check` (SETUP 6.4) to get the template id
  for `HIGHLEVEL_SETTLEMENT_TEMPLATE_ID`.
