import { UiIcon } from "@/components/ui/ui-icon";

export function MetricInfo({ label }: { label: string }) {
  return (
    <span className="metric-info" aria-label={label} tabIndex={0}>
      <UiIcon name="info" />
      <span className="metric-info__tooltip" role="tooltip">
        {label}
      </span>
    </span>
  );
}
