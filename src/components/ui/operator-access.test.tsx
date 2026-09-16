import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OperatorAccess } from "./operator-access";
import { readOperatorSession } from "@/lib/agent-runtime/operator-client";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/lib/agent-runtime/operator-client", () => ({
  readOperatorSession: vi.fn(),
  authenticatedFetch: vi.fn(),
}));

describe("operator-only account controls", () => {
  it("offers login without anonymous session controls", async () => {
    vi.mocked(readOperatorSession).mockResolvedValue({
      accessMode: "public_demo", role: "anonymous",
      expiresAt: null,
      csrfToken: null,
    });
    const { container } = render(<OperatorAccess />);
    expect(await screen.findByRole("link", { name: "登录" })).toHaveAttribute("href", "/login");
    expect(screen.queryByRole("button")).toBeNull();
    expect(container).toHaveTextContent(/^登录$/);
  });

  it.each(["private", "public_demo"] as const)("keeps logout for an operator in %s mode", async accessMode => {
    vi.mocked(readOperatorSession).mockResolvedValue({
      accessMode, role: "operator", expiresAt: Math.floor(Date.now() / 1000) + 3600, csrfToken: "a".repeat(64),
    });
    const { container } = render(<OperatorAccess />);
    await waitFor(() => expect(screen.getByRole("button", { name: "登出" })).toBeVisible());
    expect(screen.queryByRole("link")).toBeNull();
    expect(container).toHaveTextContent(/^登出$/);
  });
});
