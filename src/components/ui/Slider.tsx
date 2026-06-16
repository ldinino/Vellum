import "./Slider.css";

interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /** End-of-track captions, e.g. "Strict" ↔ "Liberal". */
  leftLabel?: string;
  rightLabel?: string;
}

/** A labelled range control styled to the retro chrome. */
export function Slider({
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.05,
  disabled,
  leftLabel,
  rightLabel,
}: SliderProps) {
  return (
    <div className={`v-slider${disabled ? " is-disabled" : ""}`}>
      {leftLabel && <span className="v-slider__end">{leftLabel}</span>}
      <input
        type="range"
        className="v-slider__input"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      {rightLabel && <span className="v-slider__end">{rightLabel}</span>}
    </div>
  );
}
