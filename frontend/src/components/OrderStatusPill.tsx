import { STATUS_LABEL, type OrderStatus } from "@/lib/ordersApi";

/**
 * Colour carries meaning here, so the label always states the status in words
 * too — colour alone would leave it unreadable to anyone who can't distinguish
 * these hues.
 */
const TONE: Record<OrderStatus, string> = {
  PENDING_PAYMENT: "border-gold/40 text-gold-dim",
  PROCESSING: "border-gold/40 text-gold-dim",
  PAID: "border-line text-ink",
  FAILED: "border-clay/40 text-clay",
  CANCELLED: "border-line text-ink-dim",
  REFUNDED: "border-line text-ink-dim",
};

export default function OrderStatusPill({ status }: { status: OrderStatus }) {
  return (
    <span
      className={`rounded-full border px-3 py-1 text-xs font-medium ${TONE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
