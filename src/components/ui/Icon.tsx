/**
 * 16×16 Fugue icon (see src/assets/icons/ATTRIBUTION.txt).
 *
 * Icons are referenced by filename without extension, e.g.
 * `<Icon name="edit-bold" />`. The curated subset lives in src/assets/icons;
 * copy more from /assets/fugue-icons-3.5.6 as features need them — any file
 * added there is picked up automatically by the glob.
 *
 * Dark mode uses a parallel set in src/assets/icons-dark, generated from the
 * pack's shadowless originals by scripts/build-dark-icons.ps1 (the black
 * linework would otherwise disappear against a dark toolbar). The two folders
 * always hold the same filenames, so only the lookup table changes.
 */

import { useSyncExternalStore } from "react";

const modules = import.meta.glob<{ default: string }>("../../assets/icons/*.png", {
  eager: true,
});
const darkModules = import.meta.glob<{ default: string }>("../../assets/icons-dark/*.png", {
  eager: true,
});

function index(mods: Record<string, { default: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, mod] of Object.entries(mods)) {
    const name = path.split("/").pop()!.replace(/\.png$/, "");
    out[name] = mod.default;
  }
  return out;
}

const icons = index(modules);
const darkIcons = index(darkModules);

/**
 * Track the theme straight off `<html data-theme>` rather than through app
 * state: icons render in menus, popups and portals, and this keeps them working
 * anywhere in the tree while still repainting the instant the theme changes.
 */
function subscribeToTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

function currentTheme(): string {
  return document.documentElement.dataset.theme ?? "light";
}

export function useIsDarkTheme(): boolean {
  return useSyncExternalStore(subscribeToTheme, currentTheme, () => "light") === "dark";
}

export type IconName = string;

interface IconProps {
  name: IconName;
  /** Accessible label; decorative when omitted. */
  label?: string;
  className?: string;
}

export function iconUrl(name: IconName, dark = false): string | undefined {
  return (dark ? darkIcons[name] : undefined) ?? icons[name];
}

export function Icon({ name, label, className }: IconProps) {
  const dark = useIsDarkTheme();
  const src = iconUrl(name, dark);
  if (!src) {
    if (import.meta.env.DEV) {
      console.warn(`Icon "${name}" is not in src/assets/icons — copy it from assets/fugue-icons-3.5.6`);
    }
    return <span className={className} style={{ width: 16, height: 16, display: "inline-block" }} />;
  }
  return (
    <img
      src={src}
      width={16}
      height={16}
      alt={label ?? ""}
      aria-hidden={label ? undefined : true}
      draggable={false}
      className={className}
    />
  );
}
