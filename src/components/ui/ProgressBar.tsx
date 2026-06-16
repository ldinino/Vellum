import "./ProgressBar.css";

interface ProgressBarProps {
  /** 0..1 fraction, or null for an indeterminate (busy) bar. */
  value: number | null;
}

/** A retro determinate/indeterminate progress bar. */
export function ProgressBar({ value }: ProgressBarProps) {
  const pct = value == null ? null : Math.max(0, Math.min(1, value));
  return (
    <div className="v-progress" role="progressbar">
      <div
        className={`v-progress__fill${pct == null ? " is-indeterminate" : ""}`}
        style={pct == null ? undefined : { width: `${Math.round(pct * 100)}%` }}
      />
    </div>
  );
}
