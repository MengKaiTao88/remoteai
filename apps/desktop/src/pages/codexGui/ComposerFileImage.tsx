import { guiText } from "../../i18n/guiText";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { invoke } from "../../api/backend";
import type { AttachmentReference } from "./attachmentTypes";
import { ImagePreview } from "./ImagePreview";
import { isInlineImage } from "./imageSources";
import styles from "./ImageAttachments.module.less";

const RESOURCE_ERROR = "图片过大，暂时无法预览。请缩小尺寸后重试。";

function previewError(error: unknown) {
  const message = error instanceof Error ? error.message : error;
  return guiText(message === RESOURCE_ERROR ? RESOURCE_ERROR : "图片无法读取，请重新选择。");
}

async function loadImage(path: string, variant: "thumbnail" | "original") {
  const { url } = await invoke<{ url: string }>("codex_gui_attachment_preview", { request: { path, variant } });
  if (!isInlineImage(url)) throw new Error(guiText("图片加载失败"));
  return url;
}

export function ComposerFileImage({ item, disabled, active, onRemove }: {
  item: AttachmentReference; disabled: boolean; active: boolean; onRemove: (path: string) => void;
}) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setUrl(undefined); setError("");
    void loadImage(item.path, "thumbnail").then(
      (url) => { if (!cancelled) setUrl(url); },
      (error: unknown) => { if (!cancelled) setError(previewError(error)); },
    );
    return () => { cancelled = true; };
  }, [item.path, attempt]);
  useEffect(() => { if (!active) setPreview(false); }, [active]);
  return <div className={styles.card}>
    {error && <span className={styles.status} role="status">{error}<button type="button"
      onClick={() => setAttempt((value) => value + 1)}>{guiText("重试")}</button>
    </span>}
    {!error && url && <button type="button" className={styles.thumbnail} aria-label={guiText("放大查看：{value1}", { value1: item.name })}
      onClick={() => setPreview(true)}>
      <img src={url} alt={item.name} onError={() => setError(previewError(undefined))} />
    </button>}
    {!error && !url && <span role="status">{guiText("正在读取…")}</span>}
    <button type="button" className={styles.remove} disabled={disabled} aria-label={guiText("移除附件：{value1}", { value1: item.name })}
      onClick={() => onRemove(item.path)}><X size={14} /></button>
    {active && preview && url && <ImagePreview thumbnail={url} description={item.name}
      load={() => loadImage(item.path, "original")} close={() => setPreview(false)} />}
  </div>;
}
