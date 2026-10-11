import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { UpdateSharingSettingsCard } from '../src/pages/settings/UpdateSharingSettingsCard';
import type { SharingPreferences } from '../src/pages/settings/useUpdateSharing';
import '../src/styles.css';
import '../src/pages/SettingsPage/index.module.less';

// Exercise the card in a narrow container without the desktop window's minimum width.
document.body.style.minWidth = '0';

let preferences: SharingPreferences = { scope: 'own', uploadKibPerSecond: 1024,
  unmeteredOnly: true, prepareAndroid: false };
mockIPC((command, args) => {
  if (command === 'set_update_sharing_preferences') {
    preferences = (args as { settings: SharingPreferences }).settings;
  }
  return { preferences, networkAllowed: !preferences.unmeteredOnly,
    peerBytes: 10 * 1024 * 1024, uploadedBytes: 2 * 1024 * 1024, retries: 2, failures: 1 };
});
createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 16, maxWidth: 760, margin: 'auto' }}>
    <UpdateSharingSettingsCard settings={{ language: 'zh' }} />
  </main>,
);
