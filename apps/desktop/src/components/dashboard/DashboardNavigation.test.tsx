// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { translate, type Translate } from "../../i18n";
import { DashboardNavigation, isToolboxPage } from "./DashboardNavigation";

const t: Translate = (key, params) => translate("en", key, params);

describe.each([
  { page: "totp", label: "2FA" },
  { page: "coze", label: "coze" },
] as const)("$label navigation", ({ page, label }) => {
  it.each(["sidebar", "toolbox"] as const)("selects the independent page from the %s menu", async (variant) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    const root = createRoot(container);
    const onPageChange = vi.fn();
    const open = vi.spyOn(window, "open");
    try {
      await act(async () => root.render(
        <DashboardNavigation page="accounts" onPageChange={onPageChange} t={t} variant={variant} />,
      ));
      const buttons = Array.from(container.querySelectorAll("button"));
      const button = buttons.find((item) => item.textContent === label);
      expect(button).toBeDefined();
      if (page === "coze") {
        const pluginsIndex = buttons.findIndex((item) => item.textContent === t("nav.skills"));
        expect(buttons[pluginsIndex + 1]).toBe(button);
      }
      await act(async () => button?.click());
      expect(onPageChange).toHaveBeenCalledWith(page);
      expect(open).not.toHaveBeenCalled();
      await act(async () => root.render(
        <DashboardNavigation page={page} onPageChange={onPageChange} t={t} variant={variant} collapsed />,
      ));
      expect(container.querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe(label);
      expect(isToolboxPage(page)).toBe(true);
    } finally {
      await act(async () => root.unmount());
      open.mockRestore();
    }
  });
});
