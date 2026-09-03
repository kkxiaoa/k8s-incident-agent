type UiIconName =
  | "activity"
  | "alert"
  | "arrow-down"
  | "arrow-up"
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "clock"
  | "copy"
  | "expand"
  | "external-link"
  | "info"
  | "refresh";

function glyph(name: UiIconName) {
  switch (name) {
    case "activity":
      return <path d="M3 12h4l2.5-7 5 14 2.5-7h4" />;
    case "alert":
      return (
        <>
          <path d="M12 6.75v6.5" />
          <path d="M12 17.25h.01" />
        </>
      );
    case "arrow-down":
      return (
        <>
          <path d="M12 4v16" />
          <path d="m6.5 14.5 5.5 5.5 5.5-5.5" />
        </>
      );
    case "arrow-up":
      return (
        <>
          <path d="M12 20V4" />
          <path d="M6.5 9.5 12 4l5.5 5.5" />
        </>
      );
    case "check":
      return <path d="m5 12.5 4.25 4.25L19 7" />;
    case "chevron-down":
      return <path d="m6.5 9 5.5 5.5L17.5 9" />;
    case "chevron-right":
      return <path d="m9 6.5 5.5 5.5L9 17.5" />;
    case "clock":
      return (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 2" />
        </>
      );
    case "copy":
      return (
        <>
          <rect x="8" y="8" width="11" height="11" rx="2" />
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
        </>
      );
    case "expand":
      return (
        <>
          <path d="M8 3H3v5" />
          <path d="m3 3 6 6" />
          <path d="M16 3h5v5" />
          <path d="m21 3-6 6" />
          <path d="M8 21H3v-5" />
          <path d="m3 21 6-6" />
          <path d="M16 21h5v-5" />
          <path d="m21 21-6-6" />
        </>
      );
    case "external-link":
      return (
        <>
          <path d="M14 5h5v5" />
          <path d="m19 5-8 8" />
          <path d="M18 13.5V18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4.5" />
        </>
      );
    case "info":
      return (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 10.75v5" />
          <path d="M12 7.75h.01" />
        </>
      );
    case "refresh":
      return (
        <>
          <path d="M21 12a9 9 0 0 1-15.64 6.08L3 16" />
          <path d="M3 21v-5h5" />
          <path d="M3 12a9 9 0 0 1 15.64-6.08L21 8" />
          <path d="M21 3v5h-5" />
        </>
      );
  }
}

export function UiIcon({
  className,
  name,
}: {
  className?: string;
  name: UiIconName;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className === undefined ? "ui-icon" : `ui-icon ${className}`}
      fill="none"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <g
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      >
        {glyph(name)}
      </g>
    </svg>
  );
}
