// HighLevel setup helper.
//
//   npx tsx scripts/highlevel-setup.ts check   verify the token and location, the
//                                              contact custom fields, and list the
//                                              Documents & Contracts templates
//   npx tsx scripts/highlevel-setup.ts fields  create the missing contact custom
//                                              fields (claim_number, settlement_amount,
//                                              portal_url) as TEXT
//
// Reads HIGHLEVEL_API_TOKEN and HIGHLEVEL_LOCATION_ID (and optionally
// HIGHLEVEL_SETTLEMENT_TEMPLATE_ID / HIGHLEVEL_USER_ID) from the environment,
// loading ./.env when the token isn't already set. Only those are required, so it
// can run before the template id is known.
import { existsSync } from 'node:fs';
import { CONTACT_CUSTOM_FIELDS, HighLevelApiError, HighLevelClient, findContactField } from '../src/adapters/highlevel/client.js';

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function makeClient(): HighLevelClient {
  if (!env('HIGHLEVEL_API_TOKEN') && existsSync('.env')) process.loadEnvFile('.env');
  const token = env('HIGHLEVEL_API_TOKEN');
  const locationId = env('HIGHLEVEL_LOCATION_ID');
  if (!token || !locationId) {
    console.error('Set HIGHLEVEL_API_TOKEN (sub-account Private Integration Token) and HIGHLEVEL_LOCATION_ID.');
    process.exit(2);
  }
  return new HighLevelClient({
    HIGHLEVEL_API_TOKEN: token,
    HIGHLEVEL_LOCATION_ID: locationId,
    HIGHLEVEL_API_VERSION: env('HIGHLEVEL_API_VERSION') ?? '2021-07-28',
    HIGHLEVEL_EMAIL_FROM: env('HIGHLEVEL_EMAIL_FROM') ?? '',
    HIGHLEVEL_EMAIL_FROM_NAME: env('HIGHLEVEL_EMAIL_FROM_NAME') ?? '',
    HIGHLEVEL_SETTLEMENT_TEMPLATE_ID: env('HIGHLEVEL_SETTLEMENT_TEMPLATE_ID') ?? '',
    HIGHLEVEL_USER_ID: env('HIGHLEVEL_USER_ID') ?? '',
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function check(hl: HighLevelClient): Promise<boolean> {
  let ok = true;

  try {
    const loc = await hl.getLocation();
    console.log(`Location: ${loc.name ?? '(no name)'} (${loc.id ?? hl.config.HIGHLEVEL_LOCATION_ID})`);
  } catch (err) {
    // Reading the location needs locations.readonly, which the integration itself doesn't use.
    const scope = err instanceof HighLevelApiError && (err.status === 401 || err.status === 403);
    console.log(`Location: could not read it${scope ? ' (token may lack locations.readonly; continuing)' : ''}: ${errorText(err)}`);
  }

  console.log('\nContact custom fields:');
  try {
    const fields = await hl.listCustomFields();
    console.log('  token OK (custom fields readable)');
    for (const { key, name } of CONTACT_CUSTOM_FIELDS) {
      const f = findContactField(fields, key);
      if (f) {
        const type = f.dataType && f.dataType !== 'TEXT' ? `  WARNING: type ${f.dataType}, expected TEXT` : '';
        console.log(`  OK       ${key.padEnd(18)} id=${f.id}  name="${f.name ?? ''}"  key=${f.fieldKey ?? ''}${type}`);
      } else {
        ok = false;
        console.log(`  MISSING  ${key.padEnd(18)} create a TEXT contact field "${name}" or run: npx tsx scripts/highlevel-setup.ts fields`);
      }
    }
  } catch (err) {
    ok = false;
    console.log(`  FAILED: ${errorText(err)}`);
  }

  console.log('\nDocuments & Contracts templates (set HIGHLEVEL_SETTLEMENT_TEMPLATE_ID to the settlement one):');
  const configured = env('HIGHLEVEL_SETTLEMENT_TEMPLATE_ID');
  try {
    const templates = (await hl.listTemplates()).filter((t) => !t.deleted);
    if (templates.length === 0) console.log('  (none found; create the settlement template under Payments > Documents & Contracts > Templates)');
    let found = false;
    for (const t of templates) {
      const tid = t._id ?? t.id ?? '';
      const mark = configured && (configured === t._id || configured === t.id) ? '  <- HIGHLEVEL_SETTLEMENT_TEMPLATE_ID' : '';
      if (mark) found = true;
      const alt = t.id && t._id && t.id !== t._id ? ` (id ${t.id})` : '';
      console.log(`  ${tid}${alt}  ${t.name ?? '(unnamed)'}${t.type ? ` [${t.type}]` : ''}${mark}`);
    }
    if (!configured) {
      ok = false;
      console.log('  HIGHLEVEL_SETTLEMENT_TEMPLATE_ID is not set.');
    } else if (!found) {
      ok = false;
      console.log(`  HIGHLEVEL_SETTLEMENT_TEMPLATE_ID=${configured} is not among these templates.`);
    }
  } catch (err) {
    ok = false;
    console.log(`  FAILED: ${errorText(err)} (the token needs the Documents & Contracts template scopes)`);
  }

  console.log('\nUsers (HIGHLEVEL_USER_ID is the user the settlement is sent as):');
  const userId = env('HIGHLEVEL_USER_ID');
  try {
    const users = await hl.listUsers();
    for (const u of users) {
      const name = u.name ?? [u.firstName, u.lastName].filter(Boolean).join(' ');
      console.log(`  ${u.id ?? ''}  ${name}${userId && u.id === userId ? '  <- HIGHLEVEL_USER_ID' : ''}`);
    }
    if (userId && !users.some((u) => u.id === userId)) console.log(`  HIGHLEVEL_USER_ID=${userId} is not among these users.`);
  } catch (err) {
    console.log(`  could not list users (token may lack users.readonly): ${errorText(err)}`);
  }
  if (!userId) {
    ok = false;
    console.log('  HIGHLEVEL_USER_ID is not set.');
  }

  console.log(ok ? '\nAll checks passed.' : '\nSome checks need attention (see above).');
  return ok;
}

async function createFields(hl: HighLevelClient): Promise<boolean> {
  const fields = await hl.listCustomFields();
  for (const { key, name } of CONTACT_CUSTOM_FIELDS) {
    const existing = findContactField(fields, key);
    if (existing) {
      console.log(`  exists   ${key.padEnd(18)} id=${existing.id}`);
      continue;
    }
    const f = await hl.createCustomField(name, 'TEXT');
    const keyNote = f.fieldKey && f.fieldKey !== `contact.${key}` ? `  (key ${f.fieldKey}; matched by name)` : '';
    console.log(`  created  ${key.padEnd(18)} id=${f.id}  name="${name}"${keyNote}`);
  }
  console.log('\nUse these as merge fields in the settlement template, e.g. {{contact.claim_number}}, {{contact.settlement_amount}}.');
  return true;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd !== 'check' && cmd !== 'fields') {
    console.error('Usage: npx tsx scripts/highlevel-setup.ts <check|fields>');
    process.exit(2);
  }
  const hl = makeClient();
  const ok = cmd === 'check' ? await check(hl) : await createFields(hl);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(errorText(err));
  process.exit(1);
});
