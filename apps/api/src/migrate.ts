import { fileURLToPath } from 'node:url';
import { createConnection } from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';

const uri = process.env.DATABASE_URL;
if (!uri) throw new Error('Missing DATABASE_URL');
const connection = await createConnection(uri);
try {
  const [result] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', ['tetafinance:migrate']);
  if (!Array.isArray(result) || !('acquired' in result[0]) || result[0].acquired !== 1) {
    throw new Error('Migration lock unavailable');
  }
  await migrate(drizzle(connection), { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
} finally {
  await connection.end();
}
