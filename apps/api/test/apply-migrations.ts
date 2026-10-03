import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Runs once per test file. Each file gets a fresh, isolated D1 instance, so
// tests never see each other's rows.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
