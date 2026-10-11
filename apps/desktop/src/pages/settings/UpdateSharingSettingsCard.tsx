import { Select, Switch } from 'antd';
import { Download } from 'lucide-react';
import { sharingCopy } from '../../../../../shared/app-update/sharingCopy';
import type { SettingsPageProps } from './types';
import { useUpdateSharing } from './useUpdateSharing';
import styles from './UpdateSharingSettingsCard.module.less';

const UPLOAD_LIMITS = [64, 128, 256, 512, 1024, 2048, 4096, 8192];
const mebibytes = (value: number) => `${(value / (1024 * 1024)).toFixed(1)} MiB`;

export function UpdateSharingSettingsCard({ settings }: { settings: Pick<SettingsPageProps, 'language'> }) {
  const enabled = '__TAURI_INTERNALS__' in window;
  const { status, saving, error, save } = useUpdateSharing(enabled);
  if (!enabled) return null;
  const copy = sharingCopy[settings.language];
  const preferences = status?.preferences;
  return <section className={`settings-card ${styles.card}`}>
    <div className="settings-icon"><Download size={23} /></div>
    <div className={`settings-card-content ${styles.content}`}>
      <div className="settings-card-copy"><h3>{copy.title}</h3><p>{copy.description}</p></div>
      {error && <p role="alert" style={{ maxWidth: 400 }}>{copy[error]}</p>}
      {preferences && <>
        <div className="settings-field">
          <label htmlFor="update-sharing-scope">{copy.scope}</label>
          <Select id="update-sharing-scope" value={preferences.scope} disabled={saving}
            style={{ minWidth: 180, maxWidth: '100%' }}
            options={(['off', 'own', 'everyone'] as const).map(value => ({ value, label: copy[value] }))}
            onChange={scope => void save({ ...preferences, scope })} />
        </div>
        {preferences.scope === 'everyone' && <p style={{ maxWidth: 400 }}>{copy.privacy}</p>}
        <div className="settings-field">
          <label htmlFor="update-sharing-limit">{copy.speed}</label>
          <Select id="update-sharing-limit" value={preferences.uploadKibPerSecond} disabled={saving}
            options={UPLOAD_LIMITS.map(value => ({ value, label: `${value} KiB/s` }))}
            onChange={uploadKibPerSecond => void save({ ...preferences, uploadKibPerSecond })} />
        </div>
        <div className="settings-field">
          <label htmlFor="update-sharing-network">{copy.unmetered}</label>
          <Switch id="update-sharing-network" checked={preferences.unmeteredOnly} disabled={saving}
            onChange={unmeteredOnly => void save({ ...preferences, unmeteredOnly })} />
        </div>
        <div className="settings-field">
          <label htmlFor="update-sharing-android">{copy.android}</label>
          <Switch id="update-sharing-android" checked={preferences.prepareAndroid} disabled={saving}
            onChange={prepareAndroid => void save({ ...preferences, prepareAndroid })} />
        </div>
        <p>{copy.androidHint}</p>
        {!status.networkAllowed && preferences.scope !== 'off' && <p>{copy.network}</p>}
        <p>{copy.stats} · {copy.received} {mebibytes(status.peerBytes)} · {copy.uploaded} {mebibytes(status.uploadedBytes)}</p>
        <p>{copy.retries} {status.retries} · {copy.failures} {status.failures}</p>
      </>}
    </div>
  </section>;
}
