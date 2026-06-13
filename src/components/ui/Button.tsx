import { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, IconName } from "./Icon";
import "./Button.css";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: IconName;
  /** Blue accent style for primary actions. */
  accent?: boolean;
  children?: ReactNode;
}

/** Soft-raised Office 2007 button with the amber hover glow. */
export function Button({ icon, accent, children, className, ...rest }: ButtonProps) {
  const classes = ["v-button"];
  if (accent) classes.push("v-button--accent");
  if (className) classes.push(className);
  return (
    <button type="button" className={classes.join(" ")} {...rest}>
      {icon && <Icon name={icon} />}
      {children && <span>{children}</span>}
    </button>
  );
}
