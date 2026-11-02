// Input from a claimant that we refuse. `message` is written for the claimant and
// is safe to show on the claim page; `code` lets a route react without parsing it.
export type ClaimantInputErrorCode =
  | 'invalid'
  | 'empty_message'
  | 'message_too_long'
  | 'empty_file'
  | 'file_too_large'
  | 'unsupported_file_type'
  | 'file_content_mismatch';

export class ClaimantInputError extends Error {
  constructor(
    message: string,
    readonly code: ClaimantInputErrorCode = 'invalid',
  ) {
    super(message);
    this.name = 'ClaimantInputError';
  }
}
