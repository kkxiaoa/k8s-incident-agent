"use client";

import { useEffect, useId, useState, type ButtonHTMLAttributes, type CSSProperties, type SyntheticEvent } from "react";

export function ActionButton({ disabledReason, disabled, id, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  disabledReason?: string;
}) {
  const generatedId = useId();
  const buttonId = id ?? generatedId;
  const hintId = `${buttonId}-hint`;
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const showHint = (event: SyntheticEvent<HTMLSpanElement>) => {
    if (!disabled || !disabledReason) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - 32);
    setPosition({ width, left: Math.max(16, Math.min(bounds.left + (bounds.width - width) / 2, window.innerWidth - width - 16)),
      ...(bounds.top > 110 ? { bottom: window.innerHeight - bounds.top + 8 } : { top: bounds.bottom + 8 }) });
  };
  useEffect(() => {
    if (!position) return;
    const close = () => setPosition(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [position]);
  const visible = disabled && disabledReason && position;
  return <span className="action-button" tabIndex={disabled && disabledReason ? 0 : undefined}
    role={disabled && disabledReason ? "group" : undefined}
    aria-labelledby={disabled && disabledReason ? buttonId : undefined}
    aria-describedby={visible ? hintId : undefined}
    onPointerEnter={showHint} onPointerLeave={(event) => {
      if (!event.currentTarget.contains(document.activeElement)) setPosition(null);
    }} onFocus={showHint} onBlur={() => setPosition(null)}
    onKeyDown={(event) => { if (event.key === "Escape") setPosition(null); }}>
    <button {...props} id={buttonId} disabled={disabled}>{children}</button>
    {visible ? <span id={hintId} role="tooltip" className="action-button__hint" style={position}>{disabledReason}</span> : null}
  </span>;
}
