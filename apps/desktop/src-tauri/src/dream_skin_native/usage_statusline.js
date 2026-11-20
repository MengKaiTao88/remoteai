const KEY = "__CODEX_SWITCH_USAGE_STATUSLINE__";
const VERSION = 15;
const REFRESH_MS = 1000;
const TIMING_REFRESH_MS = 2000;
const TIMING_TIMEOUT_MS = 10000;
const previous = window[KEY];
function isStatuslineEnabled() {
  const owner = window.__CODEX_SWITCH_SPEED_SELECTOR__;
  // Daily accounting controls only its own node; conversation metrics follow proxy availability.
  return window.__CODEX_SWITCH_COMPOSER_STATUS_ALLOWED__ === true && owner?.installed;
}
if (!isStatuslineEnabled()) { previous?.dispose(); return; }
if (previous?.version === VERSION) { void previous.refresh(); return; }
previous?.dispose();
// i18n:usage-statusline:start
const copy = {
  zh: {
    label: "会话用量统计", cache: value => `缓存命中 ${value}`,
    totalLabel: "会话累计 Token",
    totalHint: value => `本对话累计使用 ${value} 个输入和输出 Token`,
    tsrLabel: "命令执行成功率",
    activity: (turns, steps) => `${turns} 轮 ${steps} 步`,
    activityHint: "每个已记录的模型响应算一步，有至少一步的对话轮次算一轮。",
    tsrHint: "命令执行成功率：执行成功的命令占结果已知的命令的比例。",
    tsrCounts: (success, total) => `执行成功 ${success}/${total}`,
    speedHint: "当前会话已完成请求的平均输出速度，使用 Remote AI 的请求计时。",
    cacheHint: "当前会话累计缓存输入 Token 占累计输入 Token 的比例。",
    contextHint: "当前会话的上下文占用，与账号剩余额度无关。",
    waiting: "等待当前会话的用量数据。",
  },
  en: {
    label: "Conversation usage", cache: value => `Cache hit ${value}`,
    totalLabel: "Total conversation tokens",
    totalHint: value => `${value} total input and output tokens in this conversation`,
    tsrLabel: "Command success rate",
    activity: (turns, steps) => `${turns} turns ${steps} steps`,
    activityHint: "Each recorded model response is one step. A turn counts once it has a step.",
    tsrHint: "Command success rate among commands with a known result.",
    tsrCounts: (success, total) => `${success}/${total} commands succeeded`,
    speedHint: "Average output speed of completed requests in this conversation, using Remote AI request timings.",
    cacheHint: "Cumulative cached input tokens as a share of cumulative input tokens in this conversation.",
    contextHint: "Context used by this conversation, separate from account quota.",
    waiting: "Waiting for this conversation's usage data.",
  },
  ru: {
    label: "Расход в диалоге", cache: value => `Попадания в кеш ${value}`,
    totalLabel: "Всего токенов в диалоге",
    totalHint: value => `${value} входных и выходных токенов в этом диалоге`,
    tsrLabel: "Доля успешных команд",
    activity: (turns, steps) => `Ходов: ${turns}, шагов: ${steps}`,
    activityHint: "Каждый записанный ответ модели считается шагом. Ход учитывается после первого шага.",
    tsrHint: "Доля успешных команд среди команд с известным результатом.",
    tsrCounts: (success, total) => `Успешно: ${success} из ${total}`,
    speedHint: "Средняя скорость вывода завершённых запросов диалога по замерам Remote AI.",
    cacheHint: "Доля кешированных входных токенов среди всех входных токенов диалога.",
    contextHint: "Расход контекста этого диалога, отдельно от лимита аккаунта.",
    waiting: "Ожидание данных о расходе в этом диалоге.",
  },
  ja: {
    label: "会話の使用状況", cache: value => `キャッシュ命中率 ${value}`,
    totalLabel: "会話の累計トークン",
    totalHint: value => `この会話の入出力トークンの合計：${value}`,
    tsrLabel: "コマンド実行の成功率",
    activity: (turns, steps) => `${turns}ターン ${steps}ステップ`,
    activityHint: "記録されたモデルの応答を1ステップとし、ステップがあるターンを数えます。",
    tsrHint: "結果が確定したコマンドのうち、実行に成功した割合です。",
    tsrCounts: (success, total) => `${total}件中${success}件成功`,
    speedHint: "この会話で完了したリクエストの平均出力速度。",
    cacheHint: "この会話の累計入力トークンに占めるキャッシュ済みトークンの割合。",
    contextHint: "この会話のコンテキスト使用率。アカウントの残り利用枠とは異なります。",
    waiting: "この会話の使用状況を取得しています。",
  },
};
// i18n:usage-statusline:end
const state = { disposed: false, busy: false, registry: null, nextDiscovery: 0,
  bars: new Map(), conversations: new Map() };
const style = document.createElement("style");
style.textContent = __USAGE_STATUSLINE_CSS__;
document.head.append(style);
const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
function locale() {
  const language = window.__CODEX_SWITCH_SPEED_SELECTOR__?.language;
  return Object.hasOwn(copy, language) ? language : "en";
}

function createStatusline() {
  const node = document.createElement("div");
  node.className = "cs-usage-footer-container";
  node.dataset.codexSwitchUsageStatusline = "true";
  node.setAttribute("role", "status");
  const usage = document.createElement("span");
  usage.dataset.usageGroup = "base";
  const activity = document.createElement("span");
  activity.dataset.usageGroup = "activity";
  activity.hidden = true;
  node.append(usage, activity);
  const paths = ["M2 12a6 6 0 0 1 12 0M8 12l3-5",
    "M3 4c0-2 10-2 10 0s-10 2-10 0v8c0 2 10 2 10 0V4M3 8c0 2 10 2 10 0",
    null,
    "M5 11H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v1M7 5h5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z",
    "M8 4h6M5 8h6M2 12h6",
    "M4 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM5 8l2 2 4-4"];
  const parts = paths.map((shape, index) => {
    const item = document.createElement("span");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    if (index === 3 || index === 5) svg.setAttribute("role", "img");
    else svg.setAttribute("aria-hidden", "true");
    let progress = null;
    if (index === 2) progress = createContextProgress(svg);
    else {
      const path = document.createElementNS(svg.namespaceURI, "path");
      path.setAttribute("d", shape); svg.append(path);
    }
    const value = document.createElement("span");
    item.dataset.usageMetric = String(index); item.append(svg, value);
    (index < 3 ? usage : activity).append(item);
    return { item, value, progress, svg };
  });
  return { node, parts, activity };
}

function createContextProgress(svg) {
  let progress;
  for (const track of [true, false]) {
    const circle = document.createElementNS(svg.namespaceURI, "circle");
    for (const [key, value] of Object.entries({ cx: "8", cy: "8", r: "6", pathLength: "100" })) {
      circle.setAttribute(key, value);
    }
    if (track) circle.style.opacity = "0.2";
    else {
      circle.setAttribute("transform", "rotate(-90 8 8)");
      circle.setAttribute("stroke-dasharray", "0 100");
      circle.setAttribute("stroke-linecap", "butt");
      circle.dataset.contextProgress = "true";
      progress = circle;
    }
    svg.append(circle);
  }
  return progress;
}

function renderMetrics(bar, metrics, hasConversation) {
  const language = locale();
  const labels = copy[language];
  const percent = value => number(value) ? `${value.toFixed(1)}%` : "—";
  const activity = metrics?.activity;
  const tokens = metrics?.totalTokens;
  const withTotal = count(tokens);
  const { turns, steps, successfulCommandCount: success, completedCommandCount: total } = activity ?? {};
  const hasTsr = count(success) && count(total) && total > 0 && total >= success;
  const values = [number(metrics?.speed) ? `${metrics.speed.toFixed(1)} tok/s` : "— tok/s",
    labels.cache(percent(metrics?.cacheHit)), percent(metrics?.contextPercent),
    withTotal ? formatContextTokens(tokens, language) : hasConversation ? "—" : "",
    hasConversation ? labels.activity(count(turns) ? turns : "—", count(steps) ? steps : "—") : "",
    hasConversation ? percent(hasTsr ? success / total * 100 : null) : ""];
  const hints = metrics ? [labels.speedHint, labels.cacheHint, labels.contextHint] : Array(3).fill(labels.waiting);
  hints.push(withTotal ? labels.totalHint(new Intl.NumberFormat(language).format(tokens)) : labels.totalLabel,
    labels.activityHint, hasTsr ? `${labels.tsrHint} ${labels.tsrCounts(success, total)}` : labels.tsrHint);
  bar.activity.hidden = !hasConversation;
  bar.node.setAttribute("aria-label", labels.label);
  bar.parts.forEach(({ item, value, progress, svg }, index) => {
    if (index >= 3) item.hidden = !values[index];
    if (index === 3) svg.setAttribute("aria-label", labels.totalLabel);
    if (index === 5) svg.setAttribute("aria-label", labels.tsrLabel);
    if (value.textContent !== values[index]) value.textContent = values[index];
    if (item.title !== hints[index]) item.title = hints[index];
    if (progress) {
      const used = number(metrics?.contextPercent) ? Number(Math.min(100, metrics.contextPercent).toFixed(1)) : 0;
      progress.setAttribute("stroke-dasharray", `${used} 100`);
    }
  });
}

const COMPOSER_ROOT = "[data-codex-composer-root]";
const CONVERSATION_MARKER = "[data-above-composer-conversation-id]";
const EDITOR = '[contenteditable="true"], textarea:not(:disabled)';

function activeComposers() {
  const candidates = document.querySelectorAll("[data-composer-surface-variant], .composer-surface-chrome");
  const roots = new Map();
  for (const card of candidates) {
    if (!card.getClientRects().length || card.closest('[hidden], [aria-hidden="true"], [inert]')
      || !card.querySelector(EDITOR)) continue;
    const root = card.closest(COMPOSER_ROOT) ?? card;
    if (!roots.has(root)) roots.set(root, card);
  }
  return roots;
}

function activeConversationId(card) {
  const root = card.closest(COMPOSER_ROOT) ?? card;
  if (root.getAttribute("data-composer-placement") === "home") return null;
  const markers = [...root.querySelectorAll(CONVERSATION_MARKER)]
    .filter(node => node.closest(COMPOSER_ROOT) === (root.matches(COMPOSER_ROOT) ? root : null));
  const ids = new Set(markers.map(node => node.getAttribute("data-above-composer-conversation-id")).filter(Boolean));
  const fromEditor = ids.size === 1 ? null : composerConversationId(root);
  const identity = ids.size === 1 ? [...ids][0] : fromEditor;
  return typeof identity === "string" && identity.length > 0 && identity.length <= 160 ? identity : null;
}

async function discoverRegistry() {
  if (state.registry || Date.now() < state.nextDiscovery) return;
  state.nextDiscovery = Date.now() + 5000;
  state.registry = await findContextRegistry(() => state.disposed);
}

function readMetrics(id, entry) {
  // Never request/resume a thread or wrap its transport. Each pane only uses its own identity.
  const manager = state.registry?.getImplForHostId("local");
  const conversation = manager?.getConversation?.(id);
  const subscribed = entry.native.get(id);
  const snapshot = subscribed ? { latestTokenUsageInfo: subscribed }
    : conversation?.resumeState === "needs_resume" ? null : conversation;
  const timing = entry.timing;
  let metrics = composerUsageMetrics(snapshot, timing);
  // Native cumulative usage may include the fork parent. Use it only for the active context
  // estimate; never show inherited numbers while the scoped history result is still loading.
  const activity = timing?.activity;
  const { totalTokens, inputTokens, cachedInputTokens } = activity ?? {};
  const cacheHit = count(inputTokens) && inputTokens > 0 && count(cachedInputTokens)
    && cachedInputTokens <= inputTokens ? cachedInputTokens / inputTokens * 100 : null;
  if (metrics || activity) {
    metrics = { ...metrics, cacheHit, totalTokens, activity,
      contextPercent: metrics?.contextPercent ?? (!snapshot ? entry.metrics?.contextPercent : undefined) };
  }
  return (entry.metrics = metrics);
}

function requestTiming(id, entry) {
  if (typeof window.codexSwitchRequestConversationMetrics !== "function") return;
  const now = Date.now();
  if (entry.pending && now - entry.pending.time < TIMING_TIMEOUT_MS) return;
  if (entry.pending) entry.timing = null;
  if (now < entry.nextTiming) return;
  // Keep identities unique across disposal and reinstallation, including within the same millisecond.
  const requestId = Math.max(now * 1000, (window.__CODEX_SWITCH_USAGE_TIMING_REQUEST_ID__ ?? 0) + 1);
  window.__CODEX_SWITCH_USAGE_TIMING_REQUEST_ID__ = requestId;
  entry.pending = { requestId, time: now };
  entry.nextTiming = now + TIMING_REFRESH_MS;
  try {
    window.codexSwitchRequestConversationMetrics(JSON.stringify({ conversationId: id, requestId }));
  } catch { entry.pending = null; entry.timing = null; }
}

function receiveTiming(id, requestId, timing) {
  const entry = state.conversations.get(id);
  if (state.disposed || entry?.pending?.requestId !== requestId) return;
  entry.pending = null;
  entry.timing = timing;
  void refresh();
}

function syncConversations(ids) {
  for (const [id, entry] of state.conversations) {
    if (!ids.has(id)) {
      state.conversations.delete(id);
      entry.native.dispose();
    }
  }
  for (const id of ids) {
    if (!state.conversations.has(id)) {
      const native = createNativeUsageSubscription({ onChange: () => { void refresh(); } });
      state.conversations.set(id, { native, metrics: null, timing: null, pending: null, nextTiming: 0 });
    }
    state.conversations.get(id).native.select(id);
  }
}

function syncBars(composers) {
  // The account-wide daily badge already has one owner; it must not be duplicated per conversation.
  const daily = window.__CODEX_SWITCH_SPEED_SELECTOR__?.usageNode;
  if (composers.size) {
    const first = [...composers.keys()][0];
    if (!state.bars.has(first)) state.bars.set(first, createStatusline());
    const footer = state.bars.get(first).node;
    if (daily && daily.parentElement !== footer) footer.append(daily);
  }
  for (const [root, bar] of state.bars) {
    if (!composers.has(root)) {
      state.bars.delete(root);
      bar.node.remove();
    }
  }
  const panes = [];
  for (const [root, card] of composers) {
    if (!state.bars.has(root)) state.bars.set(root, createStatusline());
    const bar = state.bars.get(root);
    if (card.nextElementSibling !== bar.node) card.after(bar.node);
    panes.push({ card, bar, id: activeConversationId(card) });
  }
  return panes;
}

async function refresh() {
  if (!isStatuslineEnabled()) { api.dispose(); return; }
  if (state.disposed || state.busy || document.hidden) return;
  state.busy = true;
  try {
    const panes = syncBars(activeComposers());
    syncConversations(new Set(panes.map(pane => pane.id).filter(Boolean)));
    for (const { bar, id } of panes) renderMetrics(bar, state.conversations.get(id)?.metrics, Boolean(id));
    if ([...state.conversations.values()].some(entry => !entry.native.supported)) {
      await discoverRegistry();
    }
    if (state.disposed || document.hidden) return;
    const updated = new Map();
    for (const { card, bar, id } of panes) {
      const entry = state.conversations.get(id);
      if (!entry || !card.isConnected || activeConversationId(card) !== id) continue;
      if (!updated.has(id)) {
        requestTiming(id, entry);
        try { updated.set(id, readMetrics(id, entry)); }
        catch { state.registry = null; updated.set(id, (entry.metrics = null)); }
      }
      renderMetrics(bar, updated.get(id), true);
    }
  } catch { state.registry = null; }
  finally { state.busy = false; }
}

const timer = setInterval(refresh, REFRESH_MS);
const onVisible = () => {
  if (document.hidden) {
    for (const entry of state.conversations.values()) entry.native.select(null);
  } else void refresh();
};
document.addEventListener("visibilitychange", onVisible);
const api = { version: VERSION, refresh, receiveTiming, dispose() {
  state.disposed = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible);
  syncConversations(new Set());
  for (const bar of state.bars.values()) bar.node.remove();
  state.bars.clear(); style.remove();
  state.registry = null;
  if (window[KEY] === api) delete window[KEY];
} };
window[KEY] = api;
void refresh();
