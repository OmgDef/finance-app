export interface Config {
  databaseUrl: string;
  apiOrigin: string;
  adminOrigin: string;
  proxyIp: string | false;
  accessKey: Buffer;
  totpKey: Buffer;
  recoveryVersion: string;
}

export function configFromEnv(env = process.env): Config {
  function required(key: string) {
    const value = env[key];
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  }
  function origin(key: string) {
    const value = required(key);
    const url = new URL(value);
    const httpAllowed = env.ALLOW_HTTP === '1' && url.protocol === 'http:';
    if ((url.protocol !== 'https:' && !httpAllowed) || value !== url.origin) throw new Error(`Invalid ${key}`);
    return value;
  }
  function key(name: string) {
    const value = required(name);
    if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`Invalid ${name}`);
    return Buffer.from(value, 'hex');
  }
  const apiOrigin = origin('API_ORIGIN');
  const adminOrigin = origin('ADMIN_ORIGIN');
  if (apiOrigin === adminOrigin) throw new Error('Expected separate API and admin origins');
  const accessKey = key('ACCESS_KEY');
  const totpKey = key('TOTP_KEY');
  if (accessKey.equals(totpKey)) throw new Error('Expected separate keys');
  const recoveryVersion = env.RECOVERY_VERSION ?? '1';
  if (!/^[1-9][0-9]{0,9}$/.test(recoveryVersion)) throw new Error('Invalid RECOVERY_VERSION');
  return { databaseUrl: required('DATABASE_URL'), apiOrigin, adminOrigin,
    accessKey, totpKey, recoveryVersion, proxyIp: env.PROXY_IP || false };
}
