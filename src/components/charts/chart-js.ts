"use client";

import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  DoughnutController,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import type { Color, PointStyle, TooltipLabelStyle } from "chart.js";
import { useSyncExternalStore } from "react";

let registered = false;
const tooltipLineStyles = new Map<string, HTMLCanvasElement>();

export const TOOLTIP_LINE_MARKER = {
  boxHeight: 8,
  boxWidth: 24,
  displayColors: true,
  usePointStyle: true,
} as const;

export function tooltipLineLabelStyle(color: Color): TooltipLabelStyle {
  return {
    backgroundColor: color,
    borderColor: color,
    borderWidth: 1,
  };
}

export function tooltipLinePointStyle(
  color: string,
  dashed = false,
): { pointStyle: PointStyle; rotation: number } {
  if (typeof document === "undefined") {
    return { pointStyle: "line", rotation: 0 };
  }

  const key = `${color}:${dashed ? "dashed" : "solid"}`;
  const cached = tooltipLineStyles.get(key);
  if (cached !== undefined) {
    return { pointStyle: cached, rotation: 0 };
  }

  const canvas = document.createElement("canvas");
  canvas.width = TOOLTIP_LINE_MARKER.boxWidth;
  canvas.height = TOOLTIP_LINE_MARKER.boxHeight;
  const context = canvas.getContext("2d");
  if (context === null) {
    return { pointStyle: "line", rotation: 0 };
  }

  context.beginPath();
  context.lineCap = "round";
  context.lineWidth = 1.5;
  context.strokeStyle = color;
  context.setLineDash(dashed ? [4, 3] : []);
  context.moveTo(1.5, canvas.height / 2);
  context.lineTo(canvas.width - 1.5, canvas.height / 2);
  context.stroke();
  tooltipLineStyles.set(key, canvas);
  return { pointStyle: canvas, rotation: 0 };
}

export function ensureChartJsRegistered(): void {
  if (registered) {
    return;
  }

  ChartJS.register(
    ArcElement,
    BarController,
    BarElement,
    CategoryScale,
    DoughnutController,
    Filler,
    Legend,
    LinearScale,
    LineController,
    LineElement,
    PointElement,
    Tooltip,
  );
  registered = true;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || window.matchMedia === undefined) {
    return () => undefined;
  }
  const media = window.matchMedia(REDUCED_MOTION_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function reducedMotionSnapshot(): boolean {
  return typeof window === "undefined" || window.matchMedia === undefined
    ? true
    : window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export function useReducedChartMotion(): boolean {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    reducedMotionSnapshot,
    () => true,
  );
}
