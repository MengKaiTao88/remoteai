import { Button, Image, Space, Tag } from "antd";

export interface SourceInfo {
  documentId: string; kind: "web" | "image" | "scanned_pdf"; url?: string;
  mimeType: string; updatedAt: string; contentBase64?: string;
}

interface Props { source?: SourceInfo; busy: boolean; onRefresh: () => void; onPreview: () => void }

export function DocumentSource({ source, busy, onRefresh, onPreview }: Props) {
  if (!source) return null;
  if (source.kind === "web") return <Space wrap>
    <Tag>网页</Tag><a href={source.url} target="_blank" rel="noreferrer">查看来源</a>
    <Button size="small" type="link" loading={busy} onClick={onRefresh}>更新网页内容</Button>
  </Space>;
  return <Space><Tag>{source.kind === "image" ? "图片" : "扫描 PDF"}</Tag>
    {source.kind === "image" && <Button size="small" type="link" onClick={onPreview}>查看原图</Button>}</Space>;
}

export function OriginalImage({ source, onClose }: { source?: SourceInfo; onClose: () => void }) {
  if (!source?.contentBase64) return null;
  return <Image style={{ display: "none" }} src={`data:${source.mimeType};base64,${source.contentBase64}`}
    preview={{ visible: true, onVisibleChange: (visible) => { if (!visible) onClose(); } }} />;
}
