export function ShimmerText({ children, active = true }: { children: string; active?: boolean }) {
  if (!active) return children;
  return <span className="text-shimmer">{children}<span className="text-shimmer__highlight" data-text={children} aria-hidden="true" /></span>;
}
