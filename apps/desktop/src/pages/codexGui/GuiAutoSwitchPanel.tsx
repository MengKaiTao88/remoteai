import { Button, InputNumber, Select, Spin, Switch } from "antd";
import { ArrowLeftRight } from "lucide-react";
import { guiText } from "../../i18n/guiText";
import type { Account, Provider } from "../../types";
import { MAX_REMAINING_PERCENT } from "./autoSwitchSettings";
import type { GuiAutoSwitchSettings } from "./autoSwitchSettings";
import type { useGuiAutoSwitchSettings } from "./useGuiAutoSwitchSettings";
import { GuiAccountSettings } from "./GuiAccountSettings";
import styles from "./GuiAutoSwitchPanel.module.less";

type Editor = ReturnType<typeof useGuiAutoSwitchSettings>;
type ProviderChoice = Pick<Provider, "id" | "name">;
type FieldsProps = { settings: GuiAutoSwitchSettings; editor: Editor; providers: ProviderChoice[] };

function fallbackProviderChoices(providers: ProviderChoice[], selected: string | null) {
  const options = providers.map((provider) => ({ value: provider.id, label: provider.name }));
  if (!selected || providers.some((provider) => provider.id === selected)) return options;
  return [...options, { value: selected, label: guiText("原备用 Provider 已不可用"), disabled: true }];
}

function SwitchRules({ settings, editor, providers }: FieldsProps) {
  const disabled = editor.saving || !settings.enabled;
  return <div className={styles.rules}>
    <div className={styles.row}>
      <div><label htmlFor="gui-quota-exhaustion">{guiText("额度耗尽后切换")}</label>
        <p>{guiText("当前账号额度用完时，自动换到可用账号。")}</p></div>
      <Switch id="gui-quota-exhaustion" aria-label={guiText("额度耗尽后切换")}
        checked={settings.switchOnQuotaExhaustion} disabled={disabled}
        onChange={(switchOnQuotaExhaustion) => editor.update({ switchOnQuotaExhaustion })} />
    </div>
    <div className={styles.row}>
      <div><label htmlFor="gui-auto-switch-threshold">{guiText("默认剩余额度阈值")}</label>
        <p>{guiText("主额度低于此比例时切换；账号单独设置更高时，以较高值为准。")}</p></div>
      <InputNumber id="gui-auto-switch-threshold" aria-label={guiText("默认剩余额度阈值")} suffix="%"
        min={0} max={MAX_REMAINING_PERCENT} precision={1} value={settings.minimumRemainingPercent}
        disabled={disabled} onChange={(value) => editor.update({ minimumRemainingPercent: value ?? 0 })} />
    </div>
    <div className={styles.row}>
      <div><label htmlFor="gui-auto-switch-mode">{guiText("分配方式")}</label>
        <p>{settings.mode === "concurrent" ? guiText("不同会话优先分配不同账号，已有会话继续使用原账号。")
          : guiText("优先使用当前账号，换号时按优先级选择。")}</p></div>
      <Select id="gui-auto-switch-mode" aria-label={guiText("分配方式")} value={settings.mode} disabled={disabled}
        options={[{ value: "sequential", label: guiText("顺序切换") },
          { value: "concurrent", label: guiText("并发分配") }]}
        onChange={(mode: GuiAutoSwitchSettings["mode"]) => editor.update({ mode })} />
    </div>
    <div className={styles.row}>
      <div><label htmlFor="gui-auto-switch-provider">{guiText("备用 Provider")}</label>
        <p>{guiText("无可用账号时使用备用 Provider；手动选择的 Provider 保持不变。")}</p></div>
      <Select id="gui-auto-switch-provider" aria-label={guiText("备用 Provider")} allowClear
        placeholder={guiText("不使用备用 Provider")} value={settings.fallbackProviderId ?? undefined}
        disabled={disabled} options={fallbackProviderChoices(providers, settings.fallbackProviderId)}
        onChange={(id: string | undefined) => editor.update({ fallbackProviderId: id ?? null })} />
    </div>
  </div>;
}

export function GuiAutoSwitchPanel({ editor, accounts, providers, privacyMode }: {
  editor: Editor; accounts: Account[]; providers: ProviderChoice[]; privacyMode: boolean;
}) {
  const { settings } = editor;
  return <div className={styles.panel}>
    {editor.loading && <div className={styles.loading} role="status"><Spin size="small" />{guiText("正在读取设置…")}</div>}
    {editor.error && <div className={styles.error} role="alert"><span>{editor.error}</span>
      {!settings && <Button size="small" disabled={editor.loading}
        onClick={() => void editor.load()}>{guiText("重试")}</Button>}</div>}
    {settings && <>
      <div className={styles.enableCard} data-enabled={settings.enabled}>
        <span className={styles.enableIcon}><ArrowLeftRight size={21} strokeWidth={1.7} aria-hidden="true" /></span>
        <div><label htmlFor="gui-auto-switch-enabled">{guiText("自动切换账号")}</label>
          <p>{guiText("在需要时自动切换，让对话少些中断。")}</p></div>
        <Switch id="gui-auto-switch-enabled" aria-label={guiText("自动切换账号")}
          checked={settings.enabled} disabled={editor.saving} onChange={(enabled) => editor.update({ enabled })} />
      </div>
      <SwitchRules settings={settings} editor={editor} providers={providers} />
      <GuiAccountSettings settings={settings} editor={editor} accounts={accounts} privacyMode={privacyMode} />
    </>}
  </div>;
}
