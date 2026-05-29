const STYLES: Record<string, string> = {
  DRAFT: "border-line bg-paper text-ink-dim",
  ACTIVE: "border-sage/50 bg-sage/20 text-ink",
  RESERVED: "border-gold/40 bg-gold/10 text-gold-dim",
  SOLD: "border-line bg-blush text-ink-dim",
  REMOVED: "border-clay/30 bg-clay/10 text-clay",
};

const LABELS: Record<string, string> = {
  DRAFT: "Draft",
  ACTIVE: "Live",
  RESERVED: "Reserved",
  SOLD: "Sold",
  REMOVED: "Removed",
};

export default function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
        STYLES[status] ?? STYLES.DRAFT
      }`}
    >
      {LABELS[status] ?? status}
    </span>
  );
}
