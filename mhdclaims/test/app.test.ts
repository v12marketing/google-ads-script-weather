import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/web/app.js';

describe('redactUrl', () => {
  it('hides claim tokens, webhook secrets and query strings', () => {
    expect(redactUrl('/c/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde?code=sent')).toBe('/c/[redacted]');
    expect(redactUrl('/c/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde/files/12')).toBe('/c/[redacted]/files/12');
    expect(redactUrl('/webhooks/monday/s3cret-path-value')).toBe('/webhooks/monday/[redacted]');
    expect(redactUrl('/webhooks/highlevel/s3cret-path-value?x=1')).toBe('/webhooks/highlevel/[redacted]');
    expect(redactUrl('/find-my-claim?email=jane@example.com')).toBe('/find-my-claim');
  });

  it('leaves other paths alone', () => {
    expect(redactUrl('/')).toBe('/');
    expect(redactUrl('/admin/claims/123')).toBe('/admin/claims/123');
    expect(redactUrl('/static/site.css')).toBe('/static/site.css');
  });
});
