import { modelSelectionError, resolveModelSelection } from '../../shared/conversation/modelSelection';
import { defaultText } from '../../shared/localization/messages';
import { composerPatch, DEFAULT_COMPOSER, MODEL_CATALOG_ERROR,
  type ComposerSettings, type ComposerSnapshot } from '../../shared/remote-chat/composer';
import { CONNECTION_ERRORS } from '../../shared/remote-chat/connectionErrors';
import type { NativeGateway } from './nativeProcess';
import { modelSettings, projectModels, type NativeView } from './projection';

interface NativeCatalog { models?: unknown; currentModel?: string; currentEffort?: string }

function selection(current: ComposerSnapshot, patch: Partial<ComposerSettings>) {
  const { models, settings } = current;
  const model = patch.model ?? settings.model;
  const effort = patch.effort ?? (model === settings.model ? settings.effort : '');
  const selected = resolveModelSelection(models, { model, effort });
  const error = modelSelectionError(models, selected);
  if (error) throw new Error(defaultText(error));
  return { ...selected, access: patch.access ?? settings.access };
}

function draftDefaults(catalog: NativeCatalog, models: ComposerSnapshot['models']) {
  const model = models.find(row => row.model === catalog.currentModel);
  const effort = model?.supportedReasoningEfforts.some(row => row.reasoningEffort === catalog.currentEffort)
    ? catalog.currentEffort : '';
  return { ...DEFAULT_COMPOSER, ...resolveModelSelection(models, { model: model?.model ?? '', effort: effort ?? '' }) };
}

export class NativeComposer {
  private draft?: ComposerSettings;

  constructor(private readonly native: NativeGateway) {}

  async read(threadId: string | null, refresh: boolean): Promise<ComposerSnapshot> {
    const catalog: NativeCatalog = await this.native.call<NativeCatalog>('models', { threadId, refresh })
      .catch(error => { if (!threadId || refresh) throw error; return {}; });
    // The native catalog read hydrates saved thread metadata without navigating Codex Desktop.
    const view = threadId ? await this.native.call<NativeView>('view', { threadId, composer: true }) : undefined;
    const live = view ? modelSettings(view) : undefined;
    const models = projectModels(catalog.models, live ?? DEFAULT_COMPOSER);
    if (!models.length) throw new Error(defaultText(MODEL_CATALOG_ERROR));
    const settings = live ? { ...live, ...resolveModelSelection(models, live) }
      : this.draft ?? draftDefaults(catalog, models);
    return { models, settings, threadId, revision: Date.now(),
      ...(view?.permissionUpdate === 'nextTurn' ? { accessUpdate: 'nextTurn' } : {}) };
  }

  async write(threadId: string | null, body: unknown): Promise<ComposerSnapshot> {
    const patch = composerPatch(body);
    if (patch.speed && patch.speed !== 'normal') throw new Error(CONNECTION_ERRORS.configuration);
    const current = await this.read(threadId, false);
    const desired = selection(current, patch);
    if (!threadId) {
      this.draft = desired;
      return { ...current, settings: desired, revision: Date.now() };
    }
    const previous = current.settings;
    const changes = {
      ...(desired.model !== previous.model || desired.effort !== previous.effort
        ? { model: desired.model, effort: desired.effort } : {}),
      ...(desired.access !== previous.access ? { access: desired.access } : {}),
    };
    if (!Object.keys(changes).length) return current;
    const view = await this.native.call<NativeView>('settings', { threadId, settings: changes });
    const settings = modelSettings(view);
    if (Object.entries(changes).some(([field, value]) => settings[field as keyof ComposerSettings] !== value)) {
      throw new Error(CONNECTION_ERRORS.configuration);
    }
    return { ...current, settings, revision: Date.now(),
      accessUpdate: view.permissionUpdate === 'nextTurn' ? 'nextTurn' : undefined };
  }
}
