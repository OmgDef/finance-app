export interface Config {
  databaseUrl: string;
  apiOrigin: string;
  adminOrigin: string;
  adminUnderPath: boolean;
  proxyIp: string | false;
  accessKey: Buffer;
  totpKey: Buffer;
  profileKeys?: ReadonlyMap<number, Buffer>;
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
  const adminUnderPath = env.ADMIN_UNDER_PATH === '1';
  if (adminUnderPath) {
    if (apiOrigin !== adminOrigin || !apiOrigin.startsWith('https://')) {
      throw new Error('Expected a shared HTTPS origin for path-based admin');
    }
  } else if (apiOrigin === adminOrigin) {
    throw new Error('Expected separate API and admin origins');
  }
  const accessKey = key('ACCESS_KEY');
  const totpKey = key('TOTP_KEY');
  if (accessKey.equals(totpKey)) throw new Error('Expected separate keys');
  const profileKeys = new Map<number, Buffer>();
  for (const entry of env.PROFILE_KEYS?.split(',').filter(Boolean) ?? []) {
    const match = /^([1-9][0-9]{0,8}):([a-f0-9]{64})$/i.exec(entry);
    if (!match) throw new Error('Invalid PROFILE_KEYS');
    const version = Number(match[1]);
    const profileKey = Buffer.from(match[2]!, 'hex');
    if (profileKeys.has(version) || [accessKey, totpKey, ...profileKeys.values()].some((value) => value.equals(profileKey))) {
      throw new Error('Expected separate profile keys and unique versions');
    }
    profileKeys.set(version, profileKey);
  }
  const recoveryVersion = env.RECOVERY_VERSION ?? '1';
  if (!/^[1-9][0-9]{0,9}$/.test(recoveryVersion)) throw new Error('Invalid RECOVERY_VERSION');
  return { databaseUrl: required('DATABASE_URL'), apiOrigin, adminOrigin, adminUnderPath,
    accessKey, totpKey, profileKeys, recoveryVersion, proxyIp: env.PROXY_IP || false };
}
