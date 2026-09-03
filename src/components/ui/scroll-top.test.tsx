import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ScrollTop } from "./scroll-top";

describe("ScrollTop", () => {
  it("stays out of navigation until the page is scrolled and returns smoothly", async () => {
    const scrollY = vi.spyOn(window, "scrollY", "get").mockReturnValue(0);
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const user = userEvent.setup();

    const { container } = render(<ScrollTop />);

    const button = container.querySelector<HTMLButtonElement>(".scroll-top");
    expect(button).not.toBeNull();
    expect(button).toHaveAttribute("aria-hidden", "true");
    expect(button).toHaveAttribute("tabindex", "-1");

    scrollY.mockReturnValue(481);
    act(() => window.dispatchEvent(new Event("scroll")));

    expect(button).toHaveAttribute("aria-hidden", "false");
    expect(button).toHaveAttribute("tabindex", "0");
    await user.click(screen.getByRole("button", { name: "返回顶部" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("uses an instant return when reduced motion is requested", async () => {
    vi.spyOn(window, "scrollY", "get").mockReturnValue(481);
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: true }),
    );
    const user = userEvent.setup();

    render(<ScrollTop />);
    await user.click(screen.getByRole("button", { name: "返回顶部" }));

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
  });
});
