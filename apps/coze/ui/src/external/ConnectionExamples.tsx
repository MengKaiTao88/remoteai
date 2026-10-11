import { Alert, Input, Select, Space, Tabs, Typography } from "antd";
import { useState } from "react";
import type { Resource } from "../types";

function exampleInput(resource: Resource): Record<string, unknown> {
  if (resource.kind === "agent") return { message: "你好" };
  if (resource.kind === "knowledge") return { query: "要查询的问题" };
  if (resource.kind === "table") return { input: { filter: {} } };
  return { input: {} };
}

export function ConnectionExamples({ resource, urls, token }: {
  resource: Resource; urls: string[]; token?: string;
}) {
  const [selected, setSelected] = useState("");
  const address = urls.includes(selected) ? selected : urls[0];
  if (!address) return null;
  const authorization = `Bearer ${token || "YOUR_TOOL_KEY"}`;
  const config = JSON.stringify({ mcpServers: { coze: {
    url: `${address}/mcp`, headers: { Authorization: authorization },
  } } }, null, 2);
  const request = `POST ${address}/api/run\nAuthorization: ${authorization}\nContent-Type: application/json\n\n`
    + JSON.stringify(exampleInput(resource), null, 2);
  const code = (text: string) => <>
    <Typography.Paragraph copyable={{ text }}>复制配置</Typography.Paragraph>
    <Input.TextArea readOnly value={text} autoSize={{ minRows: 4, maxRows: 12 }} />
  </>;
  return <div>
    <Space wrap><span>连接地址</span><Select aria-label="连接地址" value={address}
      onChange={setSelected} style={{ minWidth: 250 }} options={urls.map((url, index) => ({
        value: url, label: `${index === 0 ? "本机" : "其他电脑"} · ${url}`,
      }))} /></Space>
    {!token && <p>将示例中的 YOUR_TOOL_KEY 替换为你保存的调用密钥。</p>}
    <Tabs items={[{ key: "mcp", label: "MCP 客户端", children: <>
      <p>添加 HTTP 类型的 MCP 服务，填写地址与 Authorization 请求头。支持 JSON 配置的客户端可参考：</p>
      {code(config)}</> }, { key: "api", label: "HTTP API", children: <>
      <p>此密钥会自动选择“{resource.name}”。请按已发布内容的输入要求填写参数。</p>
      {code(request)}
      <Alert type="info" message="工作流使用 input，智能体使用 message，知识库使用 query。"
        description="暂停等待回答时，将 run_id、interaction_id 和 input 发送到 /api/resume 即可继续。" />
    </> }]} />
  </div>;
}
