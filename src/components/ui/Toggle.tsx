import "./Toggle.css";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible label (also rendered as text when `children` is omitted). */
  label?: string;
}

/** An on/off switch styled to the retro chrome. */
export function Toggle({ checked, onChange, disabled, label }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`v-toggle${checked ? " is-on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="v-toggle__track">
        <span className="v-toggle__thumb" />
      </span>
      {label && <span className="v-toggle__label">{label}</span>}
    </button>
  );
}
