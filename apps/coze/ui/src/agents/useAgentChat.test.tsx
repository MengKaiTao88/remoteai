// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api";
import { useAgentChat } from "./useAgentChat";

vi.mock("../api", () => ({ api: vi.fn(), errorText: (error: unknown) => String(error) }));
let root: Root | undefined;
let chat: ReturnType<typeof useAgentChat>;
function Fixture() { chat = useAgentChat({ resourceId: "agent", published: true }); return null; }

beforeEach(async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockResolvedValue([]);
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<Fixture />));
  vi.mocked(api).mockClear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.resetAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it("displays live deltas before completion and keeps progress polling single flight", async () => {
  let resolveStatus!: (value: unknown) => void;
  vi.mocked(api).mockResolvedValueOnce({ id: "job" });
  vi.mocked(api).mockReturnValueOnce(new Promise((resolve) => { resolveStatus = resolve; }));
  await act(async () => { await chat.send("Hello"); });
  expect(api).toHaveBeenCalledWith("chat_start", { agentId: "agent", conversationId: undefined,
    message: "Hello", published: true });
  await act(async () => vi.advanceTimersByTime(2000));
  expect(api).toHaveBeenCalledTimes(2);
  await act(async () => resolveStatus({ status: "running", lastSequence: 2, events: [
    { sequence: 1, event: { type: "conversation", conversationId: "conversation" } },
    { sequence: 2, event: { type: "delta", text: "Live answer" } },
  ] }));
  expect(chat.live).toBe("Live answer"); expect(chat.busy).toBe(true);
  vi.mocked(api).mockResolvedValueOnce({ status: "completed", lastSequence: 2, events: [],
    result: { conversationId: "conversation", message: { role: "assistant", content: "Live answer", citations: [] } } });
  vi.mocked(api).mockResolvedValueOnce([{ role: "assistant", content: "Live answer", citations: [] }]);
  await act(async () => vi.advanceTimersByTime(120));
  expect(chat.busy).toBe(false); expect(chat.live).toBe("");
  expect(chat.messages[0].content).toBe("Live answer");
  expect(api).toHaveBeenCalledWith("job_status", { id: "job", after: 2 });
});

it("cancels an active request and ignores a stale response after unmount", async () => {
  let resolveStatus!: (value: unknown) => void;
  vi.mocked(api).mockResolvedValueOnce({ id: "job" });
  vi.mocked(api).mockReturnValueOnce(new Promise((resolve) => { resolveStatus = resolve; }));
  await act(async () => { await chat.send("Hello"); });
  await act(async () => chat.cancel());
  expect(api).toHaveBeenLastCalledWith("job_cancel", { id: "job" });
  await act(async () => root?.unmount()); root = undefined;
  const calls = vi.mocked(api).mock.calls.length;
  await act(async () => resolveStatus({ status: "running", lastSequence: 0, events: [] }));
  await act(async () => vi.advanceTimersByTime(5000));
  expect(api).toHaveBeenCalledTimes(calls);
});
