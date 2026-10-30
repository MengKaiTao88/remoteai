import { ShieldCheck } from "lucide-react";
import { TotpCloudSyncSwitch } from "../../components/TotpCloudSyncSwitch";
import type { SettingsPageProps } from "./types";

export function TotpSyncSettingsCard({ settings }: { settings: SettingsPageProps }) {
  const {
    cloudAuthenticated,
    onTotpCloudSyncChange,
    t,
    totpCloudSyncEnabled,
    totpCloudSyncLoading,
  } = settings;
  return (
    <section className="settings-card totp-sync-settings-card">
      <div className="settings-icon"><ShieldCheck size={23} /></div>
      <div className="settings-card-content">
        <div className="settings-card-copy">
          <h3>{t("settings.totpSync.title")}</h3>
          <p>{t("settings.totpSync.description")}</p>
        </div>
        <TotpCloudSyncSwitch settings t={t} authenticated={cloudAuthenticated}
          enabled={totpCloudSyncEnabled} loading={totpCloudSyncLoading} onChange={onTotpCloudSyncChange} />
      </div>
    </section>
  );
}
