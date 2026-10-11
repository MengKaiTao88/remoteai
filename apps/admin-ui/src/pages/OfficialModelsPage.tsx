import { Button, Card, Input, Space, Tag, Typography } from "antd";
import { useI18n } from "../i18n-context";
import { useOfficialModels, type OfficialModelsProps } from "../hooks/useOfficialModels";

export function OfficialModelsPage({ api, canManage }: OfficialModelsProps) {
  const { language } = useI18n();
  const zh = language === "zh";
  const models = useOfficialModels(api, zh);
  const busy = models.loading || models.action !== null;
  const catalog = models.snapshot?.catalog;
  const count = Array.isArray(catalog?.models) ? catalog.models.length : 0;
  return <Space direction="vertical" size="large" style={{ width: "100%" }}>
    <div>
      <Typography.Title level={2}>{zh ? "官方模型" : "Official models"}</Typography.Title>
      <Typography.Paragraph type="secondary">{zh
        ? "对外代理和 Codex GUI 优先使用此列表。每 30 分钟自动更新；更新失败或列表为空时保留现有内容。"
        : "The proxy and Codex GUI use this list first. It refreshes every 30 minutes and keeps old models on failure."}
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary">{zh
        ? "手动保存后立即可用，用户下次加载模型时生效。30 分钟后恢复自动更新。"
        : "Saved changes apply the next time users load models. Automatic updates resume after 30 minutes."}
      </Typography.Paragraph>
    </div>
    <Card loading={models.loading}>
      <Space wrap style={{ marginBottom: 16 }}>
        <Tag>{zh ? `${count} 个模型` : `${count} models`}</Tag>
        {catalog && <Typography.Text type="secondary">
          {zh ? "更新时间：" : "Updated: "}{new Date(models.snapshot!.updatedAt).toLocaleString()}
        </Typography.Text>}
        <Button disabled={busy} onClick={models.reload}>{zh ? "重新加载" : "Reload"}</Button>
        {canManage && <Button loading={models.action === "refresh"} disabled={busy || !models.snapshot}
          onClick={() => void models.submit("refresh")}>{zh ? "从官方刷新" : "Refresh from official service"}</Button>}
      </Space>
      {!catalog && <Typography.Paragraph type="secondary">{zh
        ? "尚无可用列表。可从官方刷新，或填写完整列表后保存。"
        : "No model list yet. Refresh from the official service or enter a complete list below."}
      </Typography.Paragraph>}
      <Typography.Paragraph>{zh ? "模型列表内容（JSON）" : "Model list (JSON)"}</Typography.Paragraph>
      <Input.TextArea aria-label={zh ? "模型列表内容" : "Model list content"} value={models.draft}
        onChange={(event) => models.setDraft(event.target.value)} readOnly={!canManage}
        disabled={busy || !models.snapshot} autoSize={{ minRows: 16, maxRows: 28 }}
        spellCheck={false} style={{ fontFamily: "monospace", overflowWrap: "anywhere" }} />
      {canManage && <Button type="primary" style={{ marginTop: 16 }} loading={models.action === "save"}
        disabled={busy || !models.snapshot} onClick={() => void models.submit("save")}>
        {zh ? "保存修改" : "Save changes"}
      </Button>}
    </Card>
  </Space>;
}
