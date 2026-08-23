import Image from "next/image";

export function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

/**
 * One place decides how a user is depicted, so the nav, dropdown, and account
 * page can't drift apart. Falls back to initials when there's no picture —
 * never a generic silhouette, which reads as a broken image.
 */
export default function Avatar({
  name,
  src,
  size = 36,
  className = "",
}: {
  name: string;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  const base = `relative flex shrink-0 items-center justify-center overflow-hidden rounded-full ${className}`;

  if (src) {
    return (
      <span className={base} style={{ width: size, height: size }}>
        <Image
          src={src}
          alt={`${name}'s profile picture`}
          width={size}
          height={size}
          className="h-full w-full object-cover"
          // Avatars are replaceable at the same URL only by uploading a new
          // file, which gets a new key — so caching is safe.
          unoptimized={false}
        />
      </span>
    );
  }

  return (
    <span
      className={`${base} bg-gold-dim font-semibold text-paper`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      aria-hidden="true"
    >
      {initialsOf(name)}
    </span>
  );
}
