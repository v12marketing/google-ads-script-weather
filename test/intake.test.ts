import { describe, expect, it, vi } from 'vitest';
import { JOB } from '../src/services/contracts.js';
import {
  normalisePhone,
  parseAmount,
  parseCheckbox,
  parseDate,
  parseEmail,
  parsePhone,
  readClaimFields,
} from '../src/services/claim-fields.js';
import type { MondayColumnValue } from '../src/adapters/monday/types.js';
import { addClaimItem, makeTestEnv, type TestEnv } from './helpers.js';

const cv = (o: Partial<MondayColumnValue>): MondayColumnValue => ({ id: 'c', type: 'text', text: null, value: null, ...o });

const updatesOn = (env: TestEnv, itemId: string) =>
  [...env.monday.updates.values()].filter((u) => u.itemId === itemId).map((u) => u.textBody);

describe('claim fields', () => {
  it('reads email from the value JSON or the text, validating both', () => {
    expect(parseEmail(cv({ value: '{"email":"jane@example.com","text":"Jane"}', text: 'Jane' }))).toBe('jane@example.com');
    expect(parseEmail(cv({ text: ' jane@example.com ' }))).toBe('jane@example.com');
    expect(parseEmail(cv({ text: 'not an email' }))).toBeNull();
    expect(parseEmail(cv({}))).toBeNull();
    expect(parseEmail(undefined)).toBeNull();
  });

  it('normalises phones to E.164', () => {
    expect(normalisePhone('(603) 555-0100')).toBe('+16035550100');
    expect(normalisePhone('603.555.0100')).toBe('+16035550100');
    expect(normalisePhone('1 603 555 0100')).toBe('+16035550100');
    expect(normalisePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalisePhone('555-0100')).toBeNull();
    expect(normalisePhone('call me')).toBeNull();
    expect(normalisePhone('')).toBeNull();
    expect(parsePhone(cv({ value: '{"phone":"16035550100","countryShortName":"US"}', text: '16035550100' }))).toBe('+16035550100');
    expect(parsePhone(cv({ text: '+16035550100' }))).toBe('+16035550100');
  });

  it('reads the checkbox from its JSON value or its "v" text', () => {
    expect(parseCheckbox(cv({ value: '{"checked":"true"}' }))).toBe(true);
    expect(parseCheckbox(cv({ value: '{"checked":true}' }))).toBe(true);
    expect(parseCheckbox(cv({ value: '{"checked":"false"}', text: '' }))).toBe(false);
    expect(parseCheckbox(cv({ text: 'v' }))).toBe(true);
    expect(parseCheckbox(cv({}))).toBe(false);
    expect(parseCheckbox(undefined)).toBe(false);
  });

  it('parses amounts safely: empty is null, never 0', () => {
    expect(parseAmount(cv({ text: '1250' }))).toBe(1250);
    expect(parseAmount(cv({ text: '$1,250.50' }))).toBe(1250.5);
    expect(parseAmount(cv({ text: null, value: '"980.25"' }))).toBe(980.25);
    expect(parseAmount(cv({ text: '' }))).toBeNull();
    expect(parseAmount(cv({ text: 'abc' }))).toBeNull();
    expect(parseAmount(cv({ text: '1e309' }))).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
  });

  it('parses dates from the value JSON or the text', () => {
    expect(parseDate(cv({ value: '{"date":"2026-10-22","changed_at":"x"}' }))).toBe('2026-10-22');
    expect(parseDate(cv({ text: '2026-10-22' }))).toBe('2026-10-22');
    expect(parseDate(cv({ text: 'soon' }))).toBeNull();
  });

  it('reads a whole item', () => {
    const env = makeTestEnv();
    const item = addClaimItem(env, { name: '  Mary Ann Smith ', phone: '603-555-0123', status: 'Under review', amount: 99.5 });
    const f = readClaimFields(env.board, item);
    expect(f).toMatchObject({
      name: 'Mary Ann Smith',
      firstName: 'Mary',
      email: 'jane@example.com',
      phone: '+16035550123',
      smsOptIn: true,
      statusLabel: 'Under review',
      amountClaimed: 99.5,
      settlementAmount: null,
      claimNumber: null,
    });
  });
});

describe('intake.handleItemCreated', () => {
  it('assigns sequential claim numbers and caches the claim fields', async () => {
    const env = makeTestEnv();
    const a = addClaimItem(env, { name: 'Jane Doe', phone: '(603) 555-0100' });
    const b = addClaimItem(env, { name: 'John Roe', email: 'john@example.com', phone: '6035550199', smsOptIn: false, amount: 400 });
    await env.ctx.services.intake.handleItemCreated(a.id);
    await env.ctx.services.intake.handleItemCreated(b.id);

    const ca = env.ctx.repo.getClaim(a.id)!;
    const cb = env.ctx.repo.getClaim(b.id)!;
    expect(ca.claimNumber).toBe('HDC-000001');
    expect(cb.claimNumber).toBe('HDC-000002');
    expect(ca).toMatchObject({
      claimantName: 'Jane Doe',
      firstName: 'Jane',
      email: 'jane@example.com',
      phone: '+16035550100',
      smsOptIn: true,
      statusKey: 'received',
      statusLabel: 'New',
      amountClaimed: 1250,
    });
    expect(cb).toMatchObject({ smsOptIn: false, amountClaimed: 400, phone: '+16035550199' });
  });

  it('writes the claim number, date received and portal link back to the item', async () => {
    const env = makeTestEnv();
    const item = addClaimItem(env);
    await env.ctx.services.intake.handleItemCreated(item.id);

    const claim = env.ctx.repo.getClaim(item.id)!;
    const c = env.board.columns;
    const writes = env.monday.callsTo('changeColumnValues');
    expect(writes).toHaveLength(1);
    const [boardId, itemId, values] = writes[0] as [string, string, Record<string, unknown>];
    expect(boardId).toBe(env.board.claimsBoardId);
    expect(itemId).toBe(item.id);
    expect(values[c.claimNumber]).toBe('HDC-000001');
    expect(values[c.dateReceived!]).toEqual({ date: claim.receivedAt.slice(0, 10) });
    const link = values[c.portalLink!] as string;
    expect(link).toMatch(/^https:\/\/claims\.test\/c\/[A-Za-z0-9_-]{43}$/);
    // The link opens this claim.
    expect(env.ctx.services.tokens.claimForToken(link.split('/c/')[1]!)?.itemId).toBe(item.id);
  });

  it('upserts the contact, sends the confirmation and records "Claim received"', async () => {
    const env = makeTestEnv();
    const notify = vi.spyOn(env.ctx.services.notifier, 'notify');
    const item = addClaimItem(env);
    await env.ctx.services.intake.handleItemCreated(item.id);

    const claim = env.ctx.repo.getClaim(item.id)!;
    expect(claim.highlevelContactId).toMatch(/^contact_/);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![1]).toBe('confirmation');
    expect(notify.mock.calls[0]![3]).toEqual({ eventKey: `confirmation:${item.id}` });
    expect(env.highlevel.emails).toHaveLength(1);
    expect(env.ctx.repo.listMessages(item.id).map((m) => [m.direction, m.body])).toEqual([['system', 'Claim received']]);
  });

  it('is idempotent when the webhook is redelivered', async () => {
    const env = makeTestEnv();
    const item = addClaimItem(env);
    await env.ctx.services.intake.handleItemCreated(item.id);
    await env.ctx.services.intake.handleItemCreated(item.id);
    await env.ctx.services.intake.handleItemCreated(item.id);

    expect(env.ctx.repo.getClaim(item.id)!.claimNumber).toBe('HDC-000001');
    // Values on the item now match, so nothing more is written.
    expect(env.monday.callsTo('changeColumnValues')).toHaveLength(1);
    expect(env.highlevel.emails).toHaveLength(1);
    expect(env.ctx.repo.listMessages(item.id)).toHaveLength(1);
    expect(env.ctx.jobs.list().filter((j) => j.type === JOB.mondayColumnChanged)).toHaveLength(2);

    // The next claim still gets the next number.
    const next = addClaimItem(env, { email: 'other@example.com', phone: '+16035550111' });
    await env.ctx.services.intake.handleItemCreated(next.id);
    expect(env.ctx.repo.getClaim(next.id)!.claimNumber).toBe('HDC-000002');
  });

  it('carries on after a failed Monday write-back when the job retries', async () => {
    const env = makeTestEnv();
    const item = addClaimItem(env);
    const original = env.monday.changeColumnValues.bind(env.monday);
    let fail = true;
    vi.spyOn(env.monday, 'changeColumnValues').mockImplementation(async (...args) => {
      if (fail) {
        fail = false;
        throw new Error('Monday down');
      }
      return original(...args);
    });
    await expect(env.ctx.services.intake.handleItemCreated(item.id)).rejects.toThrow('Monday down');
    expect(env.highlevel.emails).toHaveLength(0);
    await env.ctx.services.intake.handleItemCreated(item.id);
    expect(env.monday.items.get(item.id)!.columnValues[env.board.columns.claimNumber]!.text).toBe('HDC-000001');
    expect(env.highlevel.emails).toHaveLength(1);
    expect(env.ctx.repo.listMessages(item.id)).toHaveLength(1);
  });

  it('schedules delayed file syncs for late WorkForm uploads', async () => {
    const env = makeTestEnv();
    const item = addClaimItem(env);
    const before = Date.now();
    await env.ctx.services.intake.handleItemCreated(item.id);

    const jobs = env.ctx.jobs.list().filter((j) => j.type === JOB.mondayColumnChanged);
    expect(jobs.map((j) => j.dedupe_key).sort()).toEqual([`intake-files:${item.id}:1`, `intake-files:${item.id}:2`]);
    for (const j of jobs) expect(JSON.parse(j.payload)).toEqual({ itemId: item.id, columnId: env.board.columns.intakePhotos });
    const delays = jobs.map((j) => new Date(j.run_at).getTime() - before).sort((x, y) => x - y);
    expect(delays[0]).toBeGreaterThanOrEqual(25_000);
    expect(delays[0]).toBeLessThan(60_000);
    expect(delays[1]).toBeGreaterThanOrEqual(120_000);
    expect(delays[1]).toBeLessThan(300_000);
  });

  it('ignores missing items and items on other boards', async () => {
    const env = makeTestEnv();
    await env.ctx.services.intake.handleItemCreated('424242');
    const other = env.monday.addItem('555', 'Not a claim', {});
    await env.ctx.services.intake.handleItemCreated(other.id);
    expect(env.ctx.repo.getClaim(other.id)).toBeNull();
    expect(env.monday.callsTo('changeColumnValues')).toHaveLength(0);
    expect(env.monday.callsTo('createUpdate')).toHaveLength(0);
  });

  it('re-checks a claim with no contact details once, then tells the team', async () => {
    const env = makeTestEnv();
    const c = env.board.columns;
    const item = env.monday.addItem(env.board.claimsBoardId, 'Walk-in Claimant', { [c.status]: { type: 'status', text: 'New' } });
    await env.ctx.services.intake.handleItemCreated(item.id);

    expect(env.ctx.repo.getClaim(item.id)!.claimNumber).toBe('HDC-000001');
    expect(updatesOn(env, item.id)).toEqual([]);
    const recheck = env.ctx.jobs.list().find((j) => j.dedupe_key === `intake-recheck:${item.id}`);
    expect(recheck?.type).toBe(JOB.mondayItemCreated);
    expect(new Date(recheck!.run_at).getTime()).toBeGreaterThan(Date.now() + 60_000);

    // The re-check still finds nothing.
    await env.ctx.services.intake.handleItemCreated(item.id);
    await env.ctx.services.intake.handleItemCreated(item.id);
    expect(updatesOn(env, item.id)).toEqual(['No email or phone on this claim — claimant was not notified.']);
    expect(env.highlevel.emails).toHaveLength(0);
    expect(env.highlevel.contacts.size).toBe(0);
  });

  it('sends the confirmation when contact details arrive before the re-check', async () => {
    const env = makeTestEnv();
    const c = env.board.columns;
    const item = env.monday.addItem(env.board.claimsBoardId, 'Late Form', {});
    await env.ctx.services.intake.handleItemCreated(item.id);
    env.monday.setText(item.id, c.email, 'late@example.com', 'email');
    await env.ctx.services.intake.handleItemCreated(item.id);

    expect(env.ctx.repo.getClaim(item.id)!.email).toBe('late@example.com');
    expect(env.highlevel.emails).toHaveLength(1);
    expect(updatesOn(env, item.id)).toEqual([]);
  });

  it('only reads the claim columns it needs', async () => {
    const env = makeTestEnv();
    const item = addClaimItem(env);
    env.monday.items.get(item.id)!.columnValues['text_internal_notes'] = { id: 'text_internal_notes', type: 'text', text: 'secret', value: null };
    await env.ctx.services.intake.handleItemCreated(item.id);
    for (const [, columnIds] of env.monday.callsTo('getItem') as Array<[string, string[] | undefined]>) {
      expect(columnIds).toBeDefined();
      expect(columnIds).not.toContain('text_internal_notes');
      expect(columnIds).not.toContain(env.board.columns.intakePhotos);
    }
  });
});

describe('intake.refreshClaim', () => {
  it('updates the cached fields from the board', async () => {
    const env = makeTestEnv();
    const c = env.board.columns;
    const item = addClaimItem(env);
    await env.ctx.services.intake.handleItemCreated(item.id);

    const it2 = env.monday.items.get(item.id)!;
    it2.name = 'Janet Doe';
    env.monday.setText(item.id, c.email, 'janet@example.com', 'email');
    env.monday.setText(item.id, c.phone, '603 555 0177', 'phone');
    it2.columnValues[c.smsOptIn] = { id: c.smsOptIn, type: 'checkbox', text: '', value: null };
    env.monday.setText(item.id, c.status, 'Under review', 'status');
    env.monday.setText(item.id, c.settlementAmount, '800', 'numbers');
    env.monday.setText(item.id, c.amountClaimed!, '', 'numbers');

    const claim = await env.ctx.services.intake.refreshClaim(item.id);
    expect(claim).toMatchObject({
      claimantName: 'Janet Doe',
      firstName: 'Janet',
      email: 'janet@example.com',
      phone: '+16035550177',
      smsOptIn: false,
      statusKey: 'under_review',
      statusLabel: 'Under review',
      settlementAmount: 800,
      amountClaimed: null,
    });
    expect(env.ctx.repo.getClaim(item.id)).toEqual(claim);
  });

  it('keeps the claimant-facing status when the board moves to an internal label', async () => {
    const env = makeTestEnv();
    const item = addClaimItem(env, { status: 'Under review' });
    await env.ctx.services.intake.handleItemCreated(item.id);
    env.monday.setText(item.id, env.board.columns.status, 'Fraud check', 'status');
    const claim = await env.ctx.services.intake.refreshClaim(item.id);
    expect(claim).toMatchObject({ statusKey: 'under_review', statusLabel: 'Under review' });
  });

  it('returns null for an item with no claim', async () => {
    const env = makeTestEnv();
    const item = addClaimItem(env);
    expect(await env.ctx.services.intake.refreshClaim(item.id)).toBeNull();
    expect(env.monday.callsTo('getItem')).toHaveLength(0);
  });
});
