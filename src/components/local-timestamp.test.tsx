import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LocalTimestamp } from "./local-timestamp";

describe("LocalTimestamp", () => {
  it("formats in the browser timezone without an offset or milliseconds", () => {
    const { container } = render(
      <LocalTimestamp timestamp="2026-08-29T02:00:00.000Z" />,
    );
    const time = container.querySelector("time");

    expect(time).not.toBeNull();
    expect(time).toHaveAttribute("dateTime", "2026-08-29T02:00:00.000Z");
    expect(time).not.toHaveClass("local-timestamp--pending");
    expect(time?.textContent).not.toMatch(/(?:GMT|UTC)[+-]/);
    expect(time?.textContent).not.toMatch(/\.\d{3}/);
    expect(container.querySelector("script")).toBeNull();
  });

  it("server-renders a stable placeholder without an inline script", () => {
    const html = renderToString(
      <LocalTimestamp timestamp="2026-08-29T02:00:00.000Z" />,
    );

    expect(html).toContain("local-timestamp--pending");
    expect(html).toContain('aria-label="本地时间加载中"');
    expect(html).not.toContain("<script");
  });
});
