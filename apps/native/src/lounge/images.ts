import * as Picker from 'expo-image-picker';
import * as Files from 'expo-file-system';
import { manipulateAsync, SaveFormat, type Action } from 'expo-image-manipulator';
import { AVATAR_SIZE, avatarData } from '../../../../shared/lounge/avatar';
import { MAX_IMAGE_BYTES } from '../../../../shared/lounge/types';

const MAX_EDGE = 2048;
const QUALITIES = [0.85, 0.65, 0.45];
const SUPPORTED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
function bytes(base64: string) { return base64.length * 3 / 4 - (base64.match(/=+$/)?.[0].length ?? 0); }

async function encode(uri: string, actions: Action[], avatar = false, quality = 1) {
  const result = await manipulateAsync(uri, actions,
    { base64: true, format: avatar ? SaveFormat.PNG : SaveFormat.JPEG, compress: quality });
  try {
    if (!result.base64) throw new Error('client.lounge.imageFailed');
    return { data: `data:image/${avatar ? 'png' : 'jpeg'};base64,${result.base64}`, size: bytes(result.base64) };
  } finally {
    // Image manipulation creates a cache file; chat attachments themselves are kept only in memory.
    await Files.deleteAsync(result.uri, { idempotent: true });
  }
}

export async function prepareNativeImage(asset: Picker.ImagePickerAsset, avatar = false, maxBytes = MAX_IMAGE_BYTES) {
  if (asset.mimeType && !SUPPORTED.has(asset.mimeType)) throw new Error('client.lounge.imageFormat');
  if (!asset.width || !asset.height) throw new Error('client.lounge.imageFailed');
  if (avatar) {
    const side = Math.min(asset.width, asset.height);
    const result = await encode(asset.uri, [{ crop: { originX: (asset.width - side) / 2,
      originY: (asset.height - side) / 2, width: side, height: side } },
    { resize: { width: AVATAR_SIZE, height: AVATAR_SIZE } }], true);
    if (!avatarData(result.data)) throw new Error('client.lounge.imageFailed');
    return result.data;
  }
  const info = await Files.getInfoAsync(asset.uri);
  if (info.exists && info.size <= maxBytes && asset.mimeType && asset.mimeType !== 'image/webp') {
    const base64 = await Files.readAsStringAsync(asset.uri, { encoding: Files.EncodingType.Base64 });
    if (bytes(base64) <= maxBytes) return `data:${asset.mimeType};base64,${base64}`;
  }
  for (const edge of [MAX_EDGE, MAX_EDGE / 2, MAX_EDGE / 4]) {
    const scale = Math.min(1, edge / Math.max(asset.width, asset.height));
    const resize = { width: Math.max(1, Math.round(asset.width * scale)),
      height: Math.max(1, Math.round(asset.height * scale)) };
    for (const quality of QUALITIES) {
      const result = await encode(asset.uri, [{ resize }], false, quality);
      if (result.size <= maxBytes) return result.data;
    }
  }
  throw new Error('client.lounge.imageFailed');
}

export async function pickLoungeImages(options: { avatar?: boolean; remaining?: number; maxBytes?: number } = {}) {
  const result = await Picker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1,
    allowsMultipleSelection: !options.avatar, selectionLimit: options.avatar ? 1 : options.remaining });
  if (result.canceled) return { images: [], flattened: false };
  if (result.assets.length > (options.remaining ?? 1)) throw new Error('client.lounge.tooManyImages');
  const images: string[] = [];
  for (const asset of result.assets) images.push(await prepareNativeImage(asset, options.avatar, options.maxBytes));
  return { images, flattened: result.assets.some(asset => asset.mimeType === 'image/gif')
    && images.some(data => data.startsWith('data:image/jpeg')) };
}
