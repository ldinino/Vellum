import "./AdherenceControl.css";

/** Three discrete adherence levels stored as a 0..1 float (so the backend
 * `refineAdherence` / per-template override schema is unchanged). */
const LEVELS = [
  { label: "Strict", value: 0 },
  { label: "Middle", value: 0.5 },
  { label: "Liberal", value: 1 },
] as const;

interface AdherenceControlProps {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}

/** A 3-click Strict / Middle / Liberal segmented control (spec Section 9). */
export function AdherenceControl({ value, onChange, disabled }: AdherenceControlProps) {
  // Snap the stored float to the nearest level for the active state.
  const active = LEVELS.reduce((a, b) =>
    Math.abs(b.value - value) < Math.abs(a.value - value) ? b : a,
  ).value;

  return (
    <div className="v-adh" role="group" aria-label="Adherence">
      {LEVELS.map((l) => (
        <button
          key={l.label}
          type="button"
          disabled={disabled}
          aria-pressed={l.value === active}
          className={`v-adh__opt${l.value === active ? " is-active" : ""}`}
          onClick={() => onChange(l.value)}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
