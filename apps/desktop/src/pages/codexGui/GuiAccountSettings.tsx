import { InputNumber, Switch } from "antd";
import { UsersRound } from "lucide-react";
import { guiText } from "../../i18n/guiText";
import type { Account } from "../../types";
import { accountExpirationDate } from "../../utils/expiration";
import { maskAccountEmail } from "../../utils/accountPrivacy";
import { guiAccountRule, MAX_AUTO_SWITCH_PRIORITY, MAX_REMAINING_PERCENT,
  MIN_AUTO_SWITCH_PRIORITY } from "./autoSwitchSettings";
import type { GuiAutoSwitchAccountRule, GuiAutoSwitchSettings } from "./autoSwitchSettings";
import type { useGuiAutoSwitchSettings } from "./useGuiAutoSwitchSettings";
import { GuiAccountUsage } from "./GuiAccountUsage";
import styles from "./GuiAccountSettings.module.less";

type SettingsEditor = ReturnType<typeof useGuiAutoSwitchSettings>;

function AccountRule({ account, rule, disabled, onChange }: {
  account: Pick<Account, "email" | "expiresAt" | "localProxyCompatible" | "usage">; rule: GuiAutoSwitchAccountRule;
  disabled: boolean; onChange: (rule: GuiAutoSwitchAccountRule) => void;
}) {
  const unavailable = disabled || !account.localProxyCompatible;
  return <tr className={styles.account}>
    <td><span className={styles.email} title={account.email}>{account.email}</span></td>
    <td className={styles.expiration}>{accountExpirationDate(account.expiresAt, account.usage.apiExpiresAt)
      ?? guiText("未知")}</td>
    <td><GuiAccountUsage usage={account.usage.primary} label={guiText("主用量")} /></td>
    <td><GuiAccountUsage usage={account.usage.secondary} label={guiText("次用量")} /></td>
    <td>
      <Switch size="small" aria-label={guiText("{value1} 参与自动切换", { value1: account.email })} checked={rule.enabled}
        disabled={unavailable} onChange={(enabled) => onChange({ ...rule, enabled })} />
    </td>
    {account.localProxyCompatible ? <>
      <td>
        <InputNumber size="small" aria-label={guiText("{value1} 优先级", { value1: account.email })} value={rule.priority}
          min={MIN_AUTO_SWITCH_PRIORITY} max={MAX_AUTO_SWITCH_PRIORITY} precision={0}
          disabled={unavailable || !rule.enabled} onChange={(value) => onChange({ ...rule, priority: value ?? 0 })} />
      </td>
      <td>
        <InputNumber size="small" aria-label={guiText("{value1} 剩余阈值", { value1: account.email })} value={rule.thresholdPercent}
          min={0} max={MAX_REMAINING_PERCENT} precision={1} suffix="%" disabled={unavailable || !rule.enabled}
          onChange={(value) => onChange({ ...rule, thresholdPercent: value ?? 0 })} />
      </td>
    </> : <td colSpan={2} className={styles.hint}>{guiText("此账号暂不支持代理")}</td>}
  </tr>;
}

export function GuiAccountSettings({ settings, editor, accounts, privacyMode }: {
  settings: GuiAutoSwitchSettings; editor: SettingsEditor; accounts: Account[]; privacyMode: boolean;
}) {
  return <section className={styles.accounts} aria-label={guiText("参与自动切换的账号")}>
    <div className={styles.heading}>
      <h3><UsersRound size={17} aria-hidden="true" />{guiText("参与自动切换的账号")}
        <span className={styles.count}>{accounts.length}</span></h3>
      <p className={styles.hint}>{guiText("新增账号默认参与。优先级越小越优先；相同时，先用主额度剩余较少的账号。")}</p>
    </div>
    {accounts.length ? <div className={styles.accountTableScroll}>
      <table className={styles.accountTable} aria-label={guiText("参与自动切换的账号")}>
        <colgroup><col /><col className={styles.expirationColumn} />
          <col className={styles.usageColumn} /><col className={styles.usageColumn} />
          <col className={styles.participationColumn} />
          <col className={styles.numberColumn} /><col className={styles.numberColumn} /></colgroup>
        <thead><tr><th scope="col">{guiText("账号")}</th>
          <th scope="col">{guiText("有效期")}</th><th scope="col">{guiText("主用量")}</th><th scope="col">{guiText("次用量")}</th>
          <th scope="col">{guiText("参与切换")}</th>
          <th scope="col">{guiText("优先级")}</th><th scope="col">{guiText("剩余阈值")}</th></tr></thead>
        <tbody>{accounts.map((account) => <AccountRule key={account.id}
          account={{ email: privacyMode ? maskAccountEmail(account.email) : account.email,
            expiresAt: account.expiresAt, localProxyCompatible: account.localProxyCompatible, usage: account.usage }}
          rule={guiAccountRule(settings, account.id)} disabled={editor.saving || !settings.enabled}
          onChange={editor.updateAccount} />)}</tbody>
      </table>
    </div> : <div className={styles.empty}><UsersRound size={28} aria-hidden="true" /><p>{guiText("暂无可用账号")}</p></div>}
  </section>;
}
