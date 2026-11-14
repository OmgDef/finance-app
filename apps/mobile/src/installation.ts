import { getRandomBytesAsync } from 'expo-crypto';
import { requireNativeModule } from 'expo';
import * as Store from 'expo-secure-store';

const marker = requireNativeModule<{ exists(): Promise<boolean>; create(): Promise<void> }>('InstallationMarker');
const installation = 'installation';
const biometric = 'biometric';
const enabled = 'biometrics-enabled';
const local = { keychainAccessible: Store.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const protectedRead = { ...local, keychainService: 'teta-biometrics', requireAuthentication: true };

export async function secret() {
  const bytes = await getRandomBytesAsync(32);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function forgetInstallation() {
  await Store.deleteItemAsync(installation, local);
  await Store.deleteItemAsync(enabled, local);
  await Store.deleteItemAsync(biometric, protectedRead);
}

export async function initializeInstallation() {
  if (!await marker.exists()) {
    await forgetInstallation();
    await marker.create();
  }
  return Store.getItemAsync(installation, local);
}

export async function saveInstallation(value: string) {
  await Store.setItemAsync(installation, value, local);
  if (await Store.getItemAsync(installation, local) !== value) throw new Error('STORAGE');
}

export const readBiometrics = () => Store.getItemAsync(biometric, protectedRead);
export const hasBiometrics = async () => (await Store.getItemAsync(enabled, local)) === '1';
export const clearBiometrics = async () => {
  await Store.deleteItemAsync(enabled, local);
  await Store.deleteItemAsync(biometric, protectedRead);
};

export async function saveBiometrics(value: string) {
  await Store.setItemAsync(biometric, value, protectedRead);
  if (await readBiometrics() !== value) throw new Error('STORAGE');
  await Store.setItemAsync(enabled, '1', local);
}
