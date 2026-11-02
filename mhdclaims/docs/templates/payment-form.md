# Payment details form — question wording (placeholders)

The Monday WorkForm on the private finance board (see `docs/SETUP.md` section
5.5). The claim page links to it after the claimant signs the settlement. Bank
details go straight from the claimant to this board; the service never sees
them. **`[BRACKETED]` items are placeholders for the client or counsel.**

| # | Question (as the claimant sees it) | Type | Column | Notes |
|---|---|---|---|---|
| 1 | Claim number | Short text | Claim number | Pre-fill: URL parameter `claim`. Leave visible so the claimant can check it. |
| 2 | Reference | Short text | Reference | Pre-fill: URL parameter `ref`. **Hidden.** |
| 3 | How would you like to be paid? | Single select: **Mailed check** / **Direct deposit (ACH)** | Payment method | Required. Use conditional questions for 4–10. |
| 4 | Name to put on the check | Short text | Payee name | Shown for Mailed check. Required. |
| 5 | Mailing address for the check | Long text (or address fields) | Mailing address | Shown for Mailed check. Required. Help text: "Please confirm the address where we should mail your check." |
| 6 | Name on the bank account | Short text | Account holder | Shown for Direct deposit. Required. |
| 7 | Bank routing number (9 digits) | Short text | Routing number | Shown for Direct deposit. Required. |
| 8 | Bank account number | Short text | Account number | Shown for Direct deposit. Required. |
| 9 | Checking or savings? | Single select | Account type | Shown for Direct deposit. Required. |
| 10 | Upload a voided check | File upload | Voided check | Shown for Direct deposit. **Not required**; see 11. Help text: "A photo of a voided check from this account helps us make sure the payment reaches the right account." |
| 11 | I don't have a voided check to upload | Checkbox | No voided check | Shown for Direct deposit. Help text: the terms below. |
| 12 | I confirm the information above is correct | Checkbox | Confirmed | Required. |

## Terms for a claimant who doesn't upload a voided check (question 11)

Counsel provides this text (scope of work item 7). Placeholder until then:

> **[ATTORNEY-PROVIDED TERMS: e.g. that the claimant confirms they own the account,
> that the routing and account numbers are correct, that the claims entity is not
> responsible for a payment sent to the account details they entered, and any
> verification steps finance may take before paying.]**

## Column permissions

Restrict viewing of columns 6–10 (and 4–5 if preferred) to the finance team with
Monday column permissions. The integration user, if invited to the board, only
ever reads **Claim number** and **Reference** and writes **Verification**.

## Form settings

- Require login: off. reCAPTCHA: on.
- After submission: "Thank you. We've received your payment details. We'll let you
  know when your payment has been sent."
- No editing or viewing the submission afterwards.
- Hide monday branding (design panel).
