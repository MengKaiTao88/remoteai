import type { DisplaySettingsProps } from '../../../../../shared/remote-desktop/displaySettings';
import { t } from '../../i18n';
import { ResolutionDropdown } from './ResolutionDropdown';
import { DisplaySettingsHint, DisplaySettingsSection } from './DisplaySettingsSection';

export function DisplayResolutionSettings({ resolution, settings, displays, saving }: DisplaySettingsProps) {
  const current = displays.find(display => display.id === settings.displayId);
  return <DisplaySettingsSection icon="monitor" title="分辨率" description="调整远程电脑的桌面大小">
    {resolution?.options.length ? <ResolutionDropdown key={settings.displayId}
      current={current} options={resolution.options} change={resolution.change} saving={saving} />
      : <DisplaySettingsHint>{t('这台电脑暂不支持切换分辨率。')}</DisplaySettingsHint>}
  </DisplaySettingsSection>;
}
