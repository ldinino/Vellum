import { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, IconName } from "./Icon";
import "./Toolbar.css";

/** Office 2007 toolbar: gradient fill, beveled separators, grouped buttons. */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="v-toolbar" role="toolbar">{children}</div>;
}

export function ToolbarGroup({ children }: { children: ReactNode }) {
  return <div className="v-toolbar__group">{children}</div>;
}

export function ToolbarSeparator() {
  return <div className="v-toolbar__separator" aria-hidden="true" />;
}

interface ToolbarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** Tooltip + accessible name. */
  label: string;
  /** Toggled-on state (e.g. bold active at cursor). */
  active?: boolean;
  /** Show a text caption next to the icon. */
  caption?: string;
}

export function ToolbarButton({
  icon,
  label,
  active,
  caption,
  className,
  ...rest
}: ToolbarButtonProps) {
  const classes = ["v-toolbar__button"];
  if (active) classes.push("v-toolbar__button--active");
  if (className) classes.push(className);
  return (
    <button
      type="button"
      className={classes.join(" ")}
      title={label}
      aria-label={label}
      aria-pressed={active}
      {...rest}
    >
      <Icon name={icon} />
      {caption && <span>{caption}</span>}
    </button>
  );
}
