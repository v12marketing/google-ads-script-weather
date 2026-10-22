import { z } from 'zod';

// Process-level settings come from the environment. Board-specific mapping
// (column ids, status labels) lives in config/board.json — see board-config.ts.
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  // Public origin used in every link we send, e.g. https://homedeliveryclaims.com
  PUBLIC_BASE_URL: z.url(),
  DATA_DIR: z.string().default('./data'),
  BOARD_CONFIG_PATH: z.string().default('./config/board.json'),

  // 32+ random bytes, base64/hex. Derives portal link tokens, CSRF tokens and
  // signs cookies. Rotating it invalidates every portal link and device.
  APP_SECRET: z.string().min(32),

  // Secret path segment for inbound webhooks: /webhooks/monday/<secret>.
  WEBHOOK_SECRET: z.string().min(16),

  MONDAY_API_TOKEN: z.string().min(1),
  MONDAY_API_VERSION: z.string().default('2025-04'),
  // Monday user id of the integration account. Updates it authors are ignored
  // so our own posts never echo back to the claimant.
  MONDAY_INTEGRATION_USER_ID: z.string().min(1),
  // Optional signing secret used to verify Monday webhook JWTs when present.
  MONDAY_SIGNING_SECRET: z.string().optional(),

  HIGHLEVEL_API_TOKEN: z.string().min(1),
  HIGHLEVEL_LOCATION_ID: z.string().min(1),
  HIGHLEVEL_API_VERSION: z.string().default('2021-07-28'),
  HIGHLEVEL_EMAIL_FROM: z.string().min(1),
  HIGHLEVEL_EMAIL_FROM_NAME: z.string().default('Home Delivery Claims'),
  // Off until A2P 10DLC registration clears; email still goes out.
  SMS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  ADMIN_USER: z.string().default('admin'),
  // scrypt hash produced by `npm run hash-password`, format scrypt$<salt>$<hash>
  ADMIN_PASSWORD_HASH: z.string().min(1),

  // Max bytes per claimant upload.
  MAX_UPLOAD_BYTES: z.coerce.number().int().default(25 * 1024 * 1024),
  LOG_LEVEL: z.string().default('info'),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

// Config with safe values for tests and local development with fake adapters.
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    NODE_ENV: 'test',
    PORT: 0,
    HOST: '127.0.0.1',
    PUBLIC_BASE_URL: 'https://claims.test',
    DATA_DIR: ':memory:',
    BOARD_CONFIG_PATH: './config/board.example.json',
    APP_SECRET: 'test-secret-test-secret-test-secret-0123456789',
    WEBHOOK_SECRET: 'webhook-secret-123456',
    MONDAY_API_TOKEN: 'fake',
    MONDAY_API_VERSION: '2025-04',
    MONDAY_INTEGRATION_USER_ID: '999',
    MONDAY_SIGNING_SECRET: undefined,
    HIGHLEVEL_API_TOKEN: 'fake',
    HIGHLEVEL_LOCATION_ID: 'loc_test',
    HIGHLEVEL_API_VERSION: '2021-07-28',
    HIGHLEVEL_EMAIL_FROM: 'claims@claims.test',
    HIGHLEVEL_EMAIL_FROM_NAME: 'Home Delivery Claims',
    SMS_ENABLED: true,
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD_HASH: 'scrypt$unset$unset',
    MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}
