import { File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { launchImageLibraryAsync } from 'expo-image-picker';
import { avatarMaxBytes, avatarMaxPixels } from '@teta/contracts/client';

function clearPickerFile(uri: string) {
  if (!uri.startsWith(Paths.cache.uri.replace(/\/$/, '') + '/')) return;
  try {
    new File(uri).delete();
  } catch {
    // The native cache may already have removed the temporary file.
  }
}

export async function chooseProfilePhoto() {
  const result = await launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1 });
  if (result.canceled) return;

  const { uri, width, height } = result.assets[0];
  const side = Math.min(width, height);
  const context = ImageManipulator.manipulate(uri);
  try {
    if (width !== height) {
      context.crop({ originX: Math.floor((width - side) / 2), originY: Math.floor((height - side) / 2), width: side, height: side });
    }
    const size = Math.min(side, avatarMaxPixels);
    context.resize({ width: size, height: size });
    const image = await context.renderAsync();
    try {
      for (const compress of [0.82, 0.65, 0.45]) {
        const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress, base64: true });
        clearPickerFile(saved.uri);
        if (saved.base64) {
          const padding = saved.base64.endsWith('==') ? 2 : Number(saved.base64.endsWith('='));
          if (saved.base64.length * 3 / 4 - padding <= avatarMaxBytes) return saved.base64;
        }
      }
      throw new Error('INVALID_AVATAR');
    } finally {
      image.release();
    }
  } finally {
    context.release();
    clearPickerFile(uri);
  }
}
