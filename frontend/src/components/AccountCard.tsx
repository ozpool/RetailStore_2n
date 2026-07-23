import Link from "next/link";
import type { ReactNode } from "react";

/**
 * One tile in the account grid. Renders as a link when there's somewhere real
 * to go, and as a plain panel when the feature isn't built — so nothing looks
 * clickable that isn't.
 */
export default function AccountCard({
  title,
  description,
  icon,
  href,
  badge,
  meta,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  href?: string;
  badge?: ReactNode;
  meta?: string;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
            href ? "bg-blush text-gold-dim" : "bg-paper text-ink-dim"
          }`}
          aria-hidden="true"
        >
          {icon}
        </span>
        {badge}
      </div>

      <h3 className="mt-4 text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 text-sm text-ink-dim">{description}</p>
      {meta && <p className="mt-3 text-xs font-medium text-gold-dim">{meta}</p>}
    </>
  );

  const shell =
    "rounded-3xl border border-line bg-paper-card p-5 h-full flex flex-col";

  if (!href) {
    return <div className={shell}>{body}</div>;
  }

  return (
    <Link
      href={href}
      className={`${shell} group transition hover:border-gold/50 hover:shadow-md`}
    >
      {body}
      <span className="mt-4 text-sm font-medium text-gold-dim group-hover:underline">
        Open →
      </span>
    </Link>
  );
}
