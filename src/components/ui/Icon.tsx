/**
 * 16×16 Fugue icon (see src/assets/icons/ATTRIBUTION.txt).
 *
 * Icons are referenced by filename without extension, e.g.
 * `<Icon name="edit-bold" />`. The curated subset lives in src/assets/icons;
 * copy more from /assets/fugue-icons-3.5.6 as features need them — any file
 * added there is picked up automatically by the glob.
 */

const modules = import.meta.glob<{ default: string }>("../../assets/icons/*.png", {
  eager: true,
});

const icons: Record<string, string> = {};
for (const [path, mod] of Object.entries(modules)) {
  const name = path.split("/").pop()!.replace(/\.png$/, "");
  icons[name] = mod.default;
}

export type IconName = string;

interface IconProps {
  name: IconName;
  /** Accessible label; decorative when omitted. */
  label?: string;
  className?: string;
}

export function iconUrl(name: IconName): string | undefined {
  return icons[name];
}

export function Icon({ name, label, className }: IconProps) {
  const src = icons[name];
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
