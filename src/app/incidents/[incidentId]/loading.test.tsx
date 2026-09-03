import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import IncidentLoading from "./loading";

describe("IncidentLoading", () => {
  it("reserves the major regions of the current detail page", () => {
    const { container } = render(<IncidentLoading />);

    expect(screen.getByRole("main", { name: "Incident 加载中" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(container.querySelector(".detail-toolbar")).not.toBeNull();
    expect(container.querySelector(".incident-overview")).not.toBeNull();
    expect(container.querySelector(".incident-monitoring")).not.toBeNull();
    expect(container.querySelectorAll(".monitoring-health__node")).toHaveLength(
      5,
    );
    expect(
      container.querySelectorAll(".detail-loading__metric-panel"),
    ).toHaveLength(2);
    expect(container.querySelector(".run-controls")).not.toBeNull();
    expect(
      container.querySelectorAll(".detail-loading__console-panel"),
    ).toHaveLength(2);
    expect(
      container.querySelectorAll(".detail-loading__evidence-card"),
    ).toHaveLength(2);
  });
});
