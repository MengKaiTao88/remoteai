import { useId } from 'react';
import { Switch, Tooltip } from 'antd';
import styles from './TotpSyncSwitch.module.css';

interface TotpSyncSwitchProps {
  enabled: boolean;
  loading: boolean;
  authenticated?: boolean;
  onChange: (enabled: boolean) => void;
  className?: string;
  id?: string;
  copy: { label: string; on: string; off: string; loginRequired?: string };
}

export function TotpSyncSwitch({
  enabled, loading, authenticated = true, onChange, className, id, copy,
}: TotpSyncSwitchProps) {
  const generatedId = useId();
  const switchId = id ?? generatedId;
  const loginRequired = !authenticated && !enabled;
  return <div className={`${styles.control} ${className ?? ''}`}>
    <label htmlFor={switchId}>{copy.label}</label>
    <Tooltip title={loginRequired ? copy.loginRequired : null} styles={{ root: { maxWidth: 400 } }}>
      <span className={styles.switch}>
        <Switch id={switchId} aria-label={copy.label} checked={enabled} loading={loading}
          disabled={loginRequired || loading} checkedChildren={copy.on} unCheckedChildren={copy.off}
          onChange={onChange} />
      </span>
    </Tooltip>
  </div>;
}
