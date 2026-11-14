import { buildApp } from './app.ts';
import { configFromEnv } from './config.ts';
import { connect } from './db.ts';
import { verifyRecoveryVersion } from './recovery.ts';

const config = configFromEnv();
const { db, pool } = connect(config.databaseUrl);
try {
  await verifyRecoveryVersion(db, config.recoveryVersion);
} catch (error) {
  await pool.end();
  throw error;
}
const app = buildApp(config, db, Date.now, true);
app.addHook('onClose', async () => pool.end());
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => { void app.close(); });
}
await app.listen({ host: process.env.API_BIND_HOST ?? '0.0.0.0', port: Number(process.env.API_PORT ?? 3000) });
