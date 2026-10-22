// Public facts about the claims operation, shown on the website and legal pages.
// Values in [square brackets] are placeholders for counsel / the client to fill
// in before launch; the site renders them as-is so a missing value is obvious.
export const SITE = {
  brandName: 'Home Delivery Claims',
  domain: 'HomeDeliveryClaims.com',
  // The delivery service these claims are for. Shown only as a "you're in the
  // right place" hint; set to '' to leave it off the site.
  deliveryCompanyName: 'My Home Delivery',
  // The company that operates the site and decides claims ("we" in the legal pages),
  // as shown on the logo.
  legalEntityName: 'HomeDeliveryClaims.com LLC',
  // Placeholder until the client confirms the public contact mailbox.
  contactEmail: 'claims@homedeliveryclaims.com',
  mailingAddress: '[Mailing address: street, city, state, ZIP]',
  // Effective date of the Privacy Policy and Terms of Use.
  effectiveDate: '[Effective date]',
  // How long claim records are kept, as decided by the claims entity.
  retentionPeriod: '[Retention period]',
  // State whose law governs the Terms of Use.
  governingLawState: '[State]',
  // The logo's descriptor and tagline, shown in the footer.
  descriptor: 'Property damage claims management',
  tagline: 'From delivery to resolution\u2122',
  // The text-message program as registered for A2P 10DLC.
  smsProgramName: 'Home Delivery Claims claim updates',
} as const;
