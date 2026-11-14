import { configFromEnv } from './config.ts';
import { connect } from './db.ts';
import { configureAdmin } from './admin.ts';

const login = process.argv[2]?.trim();
if (!login || login.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login) || process.stdin.isTTY) {
  throw new Error('Pass the administrator email as an argument and pipe the password on stdin');
}
let password = '';
for await (const chunk of process.stdin.setEncoding('utf8')) {
  password += chunk;
  if (password.length > 258) throw new Error('Password too long');
}
password = password.replace(/\r?\n$/, '');
if (password.length < 8 || password.length > 256) throw new Error('Expected a password of 8–256 characters');
const config = configFromEnv();
const { db, pool } = connect(config.databaseUrl);
try {
  const secret = await configureAdmin(db, config.accessKey, login, password);
  process.stdout.write(secret + '\n');
} finally {
  await pool.end();
}
