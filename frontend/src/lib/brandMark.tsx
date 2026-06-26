export function MendedHeart({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <circle cx="20" cy="20" r="17" fill="#fbe6dd" stroke="#a8492f" strokeOpacity={0.3} strokeWidth={1.5} />
      <path
        d="M20 28 C20 28 9 19.5 9 12.5 C9 8 12.5 5 16 5 C18 5 19.5 6.8 20 9 C20.5 6.8 22 5 24 5 C27.5 5 31 8 31 12.5 C31 19.5 20 28 20 28 Z"
        fill="#a8492f"
      />
      <g stroke="#fdf6f0" strokeWidth={2} strokeLinecap="round">
        <line x1="11" y1="15" x2="14" y2="15" />
        <line x1="16" y1="15" x2="19" y2="15" />
        <line x1="21" y1="15" x2="24" y2="15" />
        <line x1="26" y1="15" x2="29" y2="15" />
      </g>
    </svg>
  );
}
