import { Alert, Button, Popconfirm, Progress, Space } from "antd";
import { BookOpen, Bot, Download, GitBranch } from "lucide-react";
import { isDesktopApp } from "../../api/backend";
import { guiText } from "../../i18n/guiText";
import { useCoze } from "./useCoze";
import styles from "./CozePage.module.less";

export default function CozePage({ active }: { active: boolean }) {
  const coze = useCoze(active);
  const status = coze.status;
  if (!isDesktopApp) return <div className={styles.welcome}>
    <h1>coze</h1><p>{guiText("请在这台电脑的 Remote AI 中打开 Coze。")}</p>
  </div>;
  if (status?.url) return <div className={styles.workspace}>
    {coze.error && <Alert type="error" message={coze.error} />}
    <div className={styles.toolbar}><Popconfirm title={guiText("停止 Coze？已保存的内容会保留。")}
      styles={{ root: { maxWidth: 400 } }} onConfirm={() => coze.stop()}>
      <Button size="small" loading={coze.busy}>{guiText("停止 Coze")}</Button>
    </Popconfirm></div>
    <iframe title="Coze" src={status.url} sandbox="allow-scripts allow-same-origin allow-downloads" />
  </div>;
  const progress = status?.total ? Math.floor(status.downloaded / status.total * 100) : undefined;
  const phase = status?.phase === "verifying" ? guiText("正在检查下载内容…")
    : status?.phase === "installing" || status?.phase === "starting"
      ? guiText("正在准备 Coze…") : guiText("正在下载 Coze…");
  return <div className={styles.welcome}><div className={styles.logo}>c</div><h1>coze</h1>
    <h2>{guiText("把想法变成 AI 能力")}</h2>
    <p>{guiText("创建智能体、编排工作流，让知识库和自定义工具为你工作。")}</p>
    <Space className={styles.features} size={24}><span><Bot size={19} />{guiText("智能体")}</span>
      <span><GitBranch size={19} />{guiText("工作流")}</span><span><BookOpen size={19} />{guiText("知识库")}</span></Space>
    <p>{guiText("首次使用需下载所需内容。完成后即可在本机使用，创建的工具可供 Codex GUI 调用。")}</p>
    {coze.error && <Alert type="error" message={coze.error} />}
    {coze.busy && <div className={styles.progress}><Progress percent={progress} status="active" />
      <small>{phase}</small></div>}
    <Button type="primary" size="large" icon={<Download size={17} />} loading={coze.busy}
      disabled={!status} onClick={() => void (status?.installed ? coze.start() : coze.install())}>
      {status?.installed ? guiText("打开 Coze") : guiText("下载并开始使用")}</Button>
  </div>;
}
