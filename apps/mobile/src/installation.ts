import { getRandomBytesAsync } from 'expo-crypto';
import { requireNativeModule } from 'expo';
import * as Store from 'expo-secure-store';
import { Platform } from 'react-native';

const marker = requireNativeModule<{
  exists(): Promise<boolean>;
  create(): Promise<void>;
  enableScenePrivacy?(): Promise<void>;
}>('InstallationMarker');
const installation = 'installation';
const pendingInstallation = 'pending-installation';
const biometric = 'biometric';
const enabled = 'biometrics-enabled';
const local = { keychainAccessible: Store.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const protectedRead = { ...local, keychainService: 'teta-biometrics', requireAuthentication: true };

export const enableScenePrivacy = marker.enableScenePrivacy;

export async function secret() {
  const bytes = await getRandomBytesAsync(32);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function forgetInstallation() {
  await Store.deleteItemAsync(installation, local);
  await clearPendingInstallation();
  await clearBiometrics();
}

export async function initializeInstallation() {
  if (!await marker.exists()) {
    await forgetInstallation();
    await marker.create();
  }
  const [active, pending] = await Promise.all([
    Store.getItemAsync(installation, local),
    Store.getItemAsync(pendingInstallation, local),
  ]);
  return { active, pending: pending === active ? null : pending };
}

export async function saveInstallation(value: string, pending = false) {
  const key = pending ? pendingInstallation : installation;
  await Store.setItemAsync(key, value, local);
  if (await Store.getItemAsync(key, local) !== value) throw new Error('STORAGE');
}

export const clearPendingInstallation = () => Store.deleteItemAsync(pendingInstallation, local);
export const readBiometrics = (authenticationPrompt?: string) =>
  Store.getItemAsync(biometric, { ...protectedRead, authenticationPrompt });
export const hasBiometrics = async () => (await Store.getItemAsync(enabled, local)) === '1';
export const clearBiometrics = async () => {
  await Store.deleteItemAsync(enabled, local);
  await Store.deleteItemAsync(biometric, protectedRead);
};

export async function saveBiometrics(value: string, authenticationPrompt: string) {
  await Store.setItemAsync(biometric, value, { ...protectedRead, authenticationPrompt });
  // Android authenticates the write. iOS first prompts on a protected read.
  if (Platform.OS === 'ios' && await readBiometrics(authenticationPrompt) !== value) throw new Error('STORAGE');
}

export const markBiometricsEnabled = () => Store.setItemAsync(enabled, '1', local);
