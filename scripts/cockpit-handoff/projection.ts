import { DEFAULT_COMPOSER, type ComposerSettings } from '../../shared/remote-chat/composer';
import type { GuiEvent, Item, Model, Thread, Turn } from '../../shared/conversation/types';

type RecordData = Record<string, unknown>;
const records = (value: unknown): RecordData[] => Array.isArray(value)
  ? value.filter(row => row && typeof row === 'object' && !Array.isArray(row)) : [];
const text = (value: unknown) => typeof value === 'string' ? value : '';

export type NativeView = RecordData & { id: string; sequence: number; connected: boolean };

function timestamp(value: unknown) {
  if (typeof value !== 'number' || value < 0 || !Number.isFinite(value)) return null;
  return value >= 100_000_000_000 ? value / 1000 : value;
}

function item(row: RecordData): Item {
  const id = text(row.id), content = text(row.text), type = text(row.kind), status = text(row.status) || undefined;
  switch (type) {
    case 'userMessage': case 'steeringUserMessage':
      return { id, type: 'userMessage', status, content: [{ type: 'text', text: content }] };
    case 'agentMessage': case 'assistantMessage': case 'planImplementation':
      return { id, type: 'agentMessage', status, text: content,
        phase: row.phase === 'commentary' || row.phase === 'final_answer' ? row.phase : null };
    case 'reasoning': return { id, type, status, summary: [content] };
    case 'commandExecution': return { id, type, status, command: content, aggregatedOutput: text(row.output),
      exitCode: typeof row.exitCode === 'number' ? row.exitCode : undefined };
    default: return { id, type: 'dynamicToolCall', status, tool: text(row.title), arguments: content,
      output: row.output, success: row.role !== 'error' };
  }
}

function turns(view: RecordData): Turn[] {
  return records(view.turns).flatMap(row => {
    const messages = records(row.messages);
    if (messages.some(message => text(message.id).startsWith('opening-'))) return [];
    return [{ id: text(row.id), status: text(row.status) || 'completed',
      startedAt: timestamp(row.startedAt), completedAt: timestamp(row.completedAt),
      diff: text(row.diff) || undefined,
      error: row.error ? { message: typeof row.error === 'string' ? row.error : text((row.error as RecordData).message) }
        : undefined,
      items: messages.filter(message => typeof message.id === 'string').map(item) }];
  });
}

export function projectThread(view: RecordData): Thread {
  const timeline = turns(view);
  const preview = timeline.flatMap(turn => turn.items).find(row => row.type === 'userMessage');
  const first = preview?.content?.[0];
  const name = text(view.title) || text(view.name);
  return { id: text(view.id), ...(name ? { name } : {}), cwd: text(view.cwd),
    preview: typeof first === 'object' ? text(first.text) : text(view.preview) || text(view.first_user_message),
    updatedAt: timestamp(view.recency ?? view.updated_at) ?? 0,
    status: { type: view.connected === false ? 'notLoaded' : text(view.status) || 'idle' }, turns: timeline };
}

export function modelSettings(view: NativeView): ComposerSettings {
  const access = view.permissionMode === 'full-access' ? 'danger-full-access'
    : view.permissionMode === 'ask' ? 'read-only' : DEFAULT_COMPOSER.access;
  return { model: text(view.model ?? view.latestModel), effort: text(view.effort ?? view.latestReasoningEffort), access };
}

export function projectModels(value: unknown, settings: ComposerSettings): Model[] {
  const models = records(value).flatMap(row => {
    const id = text(row.id), effort = text(row.defaultEffort);
    const efforts = Array.isArray(row.efforts) ? row.efforts.filter(e => typeof e === 'string') as string[] : [];
    if (!id || !efforts.length) return [];
    return [{ id, model: id, displayName: text(row.name) || id, isDefault: row.isDefault === true,
      defaultReasoningEffort: effort || efforts[0],
      supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: '' })) }];
  });
  const { model, effort } = settings;
  if (model && effort && !models.some(row => row.model === model)) {
    models.push({ id: model, model, displayName: model, isDefault: !models.length,
      defaultReasoningEffort: effort, supportedReasoningEfforts: [{ reasoningEffort: effort, description: '' }] });
  }
  return models;
}

const APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'item/tool/requestUserInput', 'tool/requestUserInput']);

export function approvals(view: NativeView) {
  if (!view.connected) return [];
  const active = records(view.turns).findLast(turn => turn.status === 'inProgress');
  return records(view.requests).flatMap(row => {
    if (row.supported !== true || !APPROVALS.has(text(row.method))
      || (typeof row.id !== 'string' && typeof row.id !== 'number')) return [];
    const method = row.method === 'tool/requestUserInput' ? 'item/tool/requestUserInput' : text(row.method);
    const params = { ...(row.params as GuiEvent['params']), threadId: view.id,
      turnId: typeof active?.id === 'string' ? active.id : undefined };
    return [{ nativeId: row.id, event: { id: `bridge:${view.id}:${row.id}`, method, params } satisfies GuiEvent }];
  });
}
