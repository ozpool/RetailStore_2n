import type { ReactNode } from "react";

/**
 * The reference's section header: a small red bar plus a red eyebrow label,
 * then a large heading, with optional controls on the right.
 */
export default function SectionHeading({
  eyebrow,
  title,
  right,
}: {
  eyebrow: string;
  title: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-6">
      <div>
        <span className="section-eyebrow">{eyebrow}</span>
        <h2 className="mt-4 font-serif text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          {title}
        </h2>
      </div>
      {right && <div className="flex items-center gap-3">{right}</div>}
    </div>
  );
}
