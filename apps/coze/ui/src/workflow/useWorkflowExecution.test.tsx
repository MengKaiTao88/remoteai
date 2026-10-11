// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api";
import { useWorkflowExecution } from "./useWorkflowExecution";

vi.mock("../api", () => ({ api: vi.fn(), errorText: (error: unknown) => String(error) }));
let root: Root | undefined;
let value: ReturnType<typeof useWorkflowExecution>;
function Fixture() { value = useWorkflowExecution(); return null; }

beforeEach(async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<Fixture />));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.resetAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it("keeps event polling single flight and drains the final event page", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api).mockResolvedValueOnce({ id: "job" });
  vi.mocked(api).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  await act(async () => value.start("run_start", { input: {} }));
  await act(async () => vi.advanceTimersByTime(2000));
  expect(api).toHaveBeenCalledTimes(2);
  await act(async () => finish({ status: "completed", lastSequence: 2,
    events: [{ sequence: 1, event: { type: "delta", text: "你好" } }] }));
  vi.mocked(api).mockResolvedValueOnce({ status: "completed", lastSequence: 2,
    events: [{ sequence: 2, event: { type: "node", trace: { nodeId: "end" } } }],
    result: { id: "run", status: "paused", trace: [], output: null,
      interaction: { nodeId: "ask", prompt: "继续吗？", fields: [], choices: ["继续"] } } });
  await act(async () => vi.advanceTimersByTime(200));
  expect(api).toHaveBeenLastCalledWith("job_status", { id: "job", after: 1 });
  expect(value.text).toBe("你好"); expect(value.trace).toEqual([{ nodeId: "end" }]);
  expect(value.run?.status).toBe("paused"); expect(value.busy).toBe(false);
  await act(async () => vi.advanceTimersByTime(2000));
  expect(api).toHaveBeenCalledTimes(3);
});

it("sends cancellation while a progress request is pending and cleans up on unmount", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api).mockResolvedValueOnce({ id: "job" });
  vi.mocked(api).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  await act(async () => value.start("resume_run_start", { runId: "paused", input: { answer: "继续" } }));
  vi.mocked(api).mockResolvedValueOnce({ cancelled: true });
  await act(async () => value.cancel());
  expect(api).toHaveBeenLastCalledWith("job_cancel", { id: "job" });
  await act(async () => root?.unmount()); root = undefined;
  await act(async () => finish({ status: "running", events: [], lastSequence: 0 }));
  await act(async () => vi.advanceTimersByTime(5000));
  expect(api).toHaveBeenCalledTimes(3);
});
