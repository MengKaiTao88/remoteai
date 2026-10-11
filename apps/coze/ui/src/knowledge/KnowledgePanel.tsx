import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Drawer, Empty, Input, InputNumber, List, Popconfirm, Space, Tag } from "antd";
import { BookOpen, Trash2 } from "lucide-react";
import { api, errorText } from "../api";
import type { Citation, Document, Resource } from "../types";
import { KnowledgeImport } from "./KnowledgeImport";
import { DocumentSource, OriginalImage, type SourceInfo } from "./DocumentSource";
import { useKnowledgeJob } from "./useKnowledgeJob";

export function KnowledgePanel({ resource }: { resource: Resource }) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [image, setImage] = useState<SourceInfo>();
  const [refreshId, setRefreshId] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Citation[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [size, setSize] = useState(500);
  const [overlap, setOverlap] = useState(80);
  const [preview, setPreview] = useState<{ name: string; chunks: { id: string; text: string }[] }>();
  const [editing, setEditing] = useState<{ id: string; text: string; previous: string }>();
  const refresh = useCallback(async () => {
    const [documents, sources] = await Promise.all([api<Document[]>("list_documents", { id: resource.id }),
      api<SourceInfo[]>("list_document_sources", { id: resource.id })]);
    setDocuments(documents); setSources(sources);
  }, [resource.id]);
  const job = useKnowledgeJob({ scope: resource.id, onComplete: refresh, onError: setError });
  useEffect(() => { void refresh().catch((error: unknown) => setError(errorText(error))); }, [refresh]);
  const refreshWeb = async (id: string) => {
    if (job.busy) return;
    setRefreshId(id);
    await job.start("refresh_web_document_start", { id });
  };
  const search = async () => {
    setBusy("search"); setError("");
    try { setResults(await api<Citation[]>("search", { knowledgeIds: [resource.id], query, limit: 6 })); }
    catch (error) { setError(errorText(error)); } finally { setBusy(""); }
  };
  return <div className="two-columns">
    <section className="panel"><h2>文档 <Tag>{documents.length}</Tag></h2>
      <p>导入文件后自动整理知识，在智能体和工作流中引用。</p>
      {error && <Alert type="error" message={error} />}
      <Space wrap><label>分段字数 <InputNumber aria-label="分段字数" min={100} max={2000} value={size}
        onChange={(value) => setSize(value ?? 500)} /></label>
        <label>重叠字数 <InputNumber aria-label="重叠字数" min={0} max={Math.floor(size / 2) - 1}
          value={overlap} onChange={(value) => setOverlap(value ?? 0)} /></label></Space>
      <KnowledgeImport knowledgeId={resource.id} chunk={{ size, overlap }} job={job} onError={setError} />
      {job.progress && <Space wrap><span role="status">{job.progress}</span>
        {job.cancellable && <Button size="small" onClick={() => void job.cancel()}>取消导入</Button>}</Space>}
      <List dataSource={documents} locale={{ emptyText: "还没有文档" }} renderItem={(document) => <List.Item actions={[
        <Button key="view" type="text" onClick={() => void api<{ id: string; text: string }[]>("read_chunks",
          { id: document.id }).then((chunks) => setPreview({ name: document.name, chunks }))
          .catch((error: unknown) => setError(errorText(error)))}>查看分段</Button>,
        <Popconfirm key="delete" title="删除此文档和它的全部分段？" overlayStyle={{ maxWidth: 400 }}
          onConfirm={async () => { try { await api("delete_document", { id: document.id }); await refresh(); }
            catch (error) { setError(errorText(error)); } }}>
          <Button type="text" danger icon={<Trash2 size={15} />} aria-label={`删除 ${document.name}`} />
        </Popconfirm>,
      ]}><List.Item.Meta avatar={<BookOpen size={20} />} title={document.name}
        description={<><div>{document.chunks} 个分段 · {(document.bytes / 1024).toFixed(1)} KB</div>
          <DocumentSource source={sources.find((source) => source.documentId === document.id)}
            busy={job.busy && refreshId === document.id} onRefresh={() => void refreshWeb(document.id)}
            onPreview={() => void api<SourceInfo>("document_source", { id: document.id }).then(setImage)
              .catch((error: unknown) => setError(errorText(error)))} /></>} /></List.Item>} />
    </section>
    <section className="panel"><h2>检索测试</h2><p>输入问题，查看知识库能够找到的内容。</p>
      <Input.Search value={query} onChange={(event) => setQuery(event.target.value)} placeholder="试着问一个问题"
        enterButton="检索" loading={busy === "search"} disabled={Boolean(busy) || !documents.length}
        onSearch={() => { if (query.trim()) void search(); }} />
      {!results.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="检索结果将显示在这里" />}
      {results.map((item, index) => <article className="citation" key={item.chunkId}>
        <strong>[{index + 1}] {item.documentName}</strong><p>{item.text}</p></article>)}
    </section>
    <Drawer title={preview?.name} open={Boolean(preview)} onClose={() => setPreview(undefined)} width={600}>
      {preview?.chunks.map((chunk, index) => <article className="citation" key={chunk.id}>
        <strong>分段 {index + 1}</strong>{editing?.id === chunk.id ? <>
          <Input.TextArea rows={8} value={editing.text} maxLength={2000}
            onChange={(event) => setEditing({ ...editing, text: event.target.value })} />
          <Space><Button loading={busy === "edit"} onClick={() => {
            setBusy("edit");
            void api("update_chunk", editing).then(() => {
              setPreview({ ...preview, chunks: preview.chunks.map((item) => item.id === editing.id
                ? { ...item, text: editing.text } : item) }); setEditing(undefined);
            }).catch((error: unknown) => setError(errorText(error))).finally(() => setBusy(""));
          }}>保存分段</Button><Button onClick={() => setEditing(undefined)}>取消</Button></Space>
        </> : <><p>{chunk.text}</p><Button type="text" onClick={() => setEditing({ ...chunk, previous: chunk.text })}>
          编辑分段</Button></>}</article>)}
    </Drawer>
    <OriginalImage source={image} onClose={() => setImage(undefined)} />
  </div>;
}
