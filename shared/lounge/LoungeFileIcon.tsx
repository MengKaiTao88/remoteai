import { File, FileArchive, FileCode2, FileImage, FileMusic, FileText, FileVideo } from 'lucide-react';
import { attachmentExtension, loungePreviewKind } from './filePresentation';
import type { LoungeAttachment } from './attachments';

export function LoungeFileIcon({ file }: { file: LoungeAttachment }) {
  const kind = loungePreviewKind(file);
  const extension = attachmentExtension(file.name);
  const Icon = kind === 'image' ? FileImage : kind === 'video' ? FileVideo : kind === 'audio' ? FileMusic
    : kind === 'html' || kind === 'text' ? FileCode2 : kind === 'pdf' || kind === 'markdown' ? FileText
      : /^(ZIP|RAR|7Z|TAR|GZ)$/.test(extension) ? FileArchive : File;
  return <span className={`lounge-file-icon is-${kind ?? 'file'}`} aria-hidden="true">
    <Icon size={28} strokeWidth={1.6} /><span>{extension}</span>
  </span>;
}
