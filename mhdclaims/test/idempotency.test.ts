import { describe, expect, it } from 'vitest';
import { idempotencyKeyFor, onceFor } from '../src/services/claim-fields.js';
import { addClaimItem, makeTestEnv } from './helpers.js';

// Monday writes made once per key (onceFor) carry an Idempotency-Key derived
// from that key, so a job retried after a lost response doesn't post twice.

describe('onceFor and Monday idempotency (#33)', () => {
  it('derives a short, stable key per once-key', () => {
    expect(idempotencyKeyFor('settlement-signed:1:abc')).toBe(idempotencyKeyFor('settlement-signed:1:abc'));
    expect(idempotencyKeyFor('settlement-signed:1:abc')).not.toBe(idempotencyKeyFor('settlement-signed:2:abc'));
    expect(idempotencyKeyFor('x'.repeat(500))).toMatch(/^hdc-[0-9a-f]{32}$/);
  });

  it('a note whose response was lost after Monday posted it is not posted again when the job retries', async () => {
    const env = makeTestEnv();
    const item = addClaimItem(env);
    const notes = () => [...env.monday.updates.values()].filter((u) => u.itemId === item.id);
    const post = (once: { idempotencyKey?: string }) => env.monday.createUpdate(item.id, '<p>Settlement signed</p>', once);

    env.monday.loseNextResponse = 1;
    await expect(onceFor(env.ctx, 'note:1', post)).rejects.toThrow();
    expect(env.ctx.repo.isEventProcessed('note:1')).toBe(false);
    expect(await onceFor(env.ctx, 'note:1', post)).toBe(true);
    expect(notes()).toHaveLength(1);

    // Another key is another note.
    await onceFor(env.ctx, 'note:2', post);
    expect(notes()).toHaveLength(2);
  });
});
