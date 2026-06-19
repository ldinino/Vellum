import "./AdherenceControl.css";

/** Three discrete adherence stops stored as a 0..1 float (so the backend
 * `refineAdherence` / per-template override schema is unchanged). */
const STEPS = [0, 0.5, 1] as const;
const LABELS = ["Strict", "Moderate", "Liberal"] as const;

interface AdherenceControlProps {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}

/** A 3-stop Strict / Moderate / Liberal slider (spec Section 9). Snaps to the
 * nearest stop; the labels beneath mark the positions. */
export function AdherenceControl({ value, onChange, disabled }: AdherenceControlProps) {
  // Snap the stored float to the nearest stop index.
  let idx = 0;
  let best = Infinity;
  STEPS.forEach((s, i) => {
    const d = Math.abs(s - value);
    if (d < best) {
      best = d;
      idx = i;
    }
  });

  return (
    <div className={`v-adh${disabled ? " is-disabled" : ""}`}>
      <input
        type="range"
        className="v-adh__input"
        min={0}
        max={2}
        step={1}
        value={idx}
        disabled={disabled}
        aria-label="Adherence"
        aria-valuetext={LABELS[idx]}
        onChange={(e) => onChange(STEPS[parseInt(e.target.value, 10)])}
      />
      <div className="v-adh__labels" aria-hidden="true">
        {LABELS.map((l, i) => (
          <span key={l} className={`v-adh__label${i === idx ? " is-active" : ""}`}>
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}
