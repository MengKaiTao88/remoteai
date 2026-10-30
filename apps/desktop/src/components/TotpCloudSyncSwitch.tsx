import { TotpSyncSwitch } from '../../../../shared/totp/TotpSyncSwitch';
import type { Translate } from '../i18n';

interface TotpCloudSyncSwitchProps {
  authenticated: boolean;
  enabled: boolean;
  loading: boolean;
  onChange: (enabled: boolean) => void;
  t: Translate;
  settings?: boolean;
}

export function TotpCloudSyncSwitch({ t, settings, ...props }: TotpCloudSyncSwitchProps) {
  return <TotpSyncSwitch {...props}
    id={settings ? 'totp-cloud-sync-enabled' : 'totp-page-cloud-sync-enabled'}
    className={settings ? 'settings-field' : undefined}
    copy={{
      label: t(settings ? 'settings.totpSync.label' : 'settings.totpSync.title'),
      on: t('settings.autoRefresh.on'), off: t('settings.autoRefresh.off'),
      loginRequired: t('settings.totpSync.loginRequired'),
    }} />;
}
