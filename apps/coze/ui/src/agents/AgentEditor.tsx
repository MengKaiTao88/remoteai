import type { Draft, Resource } from "../types";
import { AgentSettings } from "./AgentSettings";
import { AgentPreview } from "./AgentPreview";

interface Props {
  resource: Resource; resources: Resource[]; draft: Draft; onChange: (draft: Draft) => void;
  save?: () => Promise<Resource>;
}

export function AgentEditor({ resource, resources, draft, onChange, save }: Props) {
  return <div className="two-columns agent-editor">
    <AgentSettings resources={resources} draft={draft} onChange={onChange} />
    <AgentPreview key={resource.id} resource={resource} draft={draft} save={save} />
  </div>;
}
