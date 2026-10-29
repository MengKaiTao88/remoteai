import { invoke, isTauri } from '@tauri-apps/api/core';
import { imageData } from './types';
import { base64Bytes, MIB } from '../remote-chat/policy';

const DOWNLOAD_URL_LIFETIME_MS = 1000;
const NATIVE_IMAGE_ACTION_LIMIT = 20 * MIB;

/** Save the received image bytes on the viewing device, including in desktop remote mode. */
export async function saveLoungeImage(uri: string): Promise<void> {
  // A later send-limit reduction must not prevent saving an image already received and cached.
  if (!imageData(uri, Number.MAX_SAFE_INTEGER)) {
    throw new Error('client.workspaceActions.couldNotSaveTheImagePleaseTryAgain');
  }
  if (isTauri() && base64Bytes(uri) <= NATIVE_IMAGE_ACTION_LIMIT) {
    // Cancellation is a normal result; the native action owns the destination and byte validation.
    await invoke<{ completed: boolean }>('codex_gui_image_action', { request: { source: uri, action: 'saveAs' } });
    return;
  }
  // Larger configured attachments use the same WebView download path as received files.
  downloadImage(uri);
}

function downloadImage(uri: string) {
  const mime = uri.slice('data:'.length, uri.indexOf(';'));
  const bytes = Uint8Array.from(atob(uri.slice(uri.indexOf(',') + 1)), character => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `RemoteAI-image.${mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length)}`;
  try {
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
  }
}
