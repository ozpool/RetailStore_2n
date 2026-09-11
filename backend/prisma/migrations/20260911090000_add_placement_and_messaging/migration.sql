-- Seller-admin messaging, and paid homepage placement.
-- See docs/adr/0033-seller-admin-messaging.md and
--     docs/adr/0034-paid-homepage-placement.md
--
-- Two features that turn out to be one: a placement request that can be
-- countered is a conversation, so the negotiation needs a thread to live in.
-- No money moves through any of this. `agreedCents` is what both sides settled
-- on; there is no seller-to-platform charge in this application.

-- Two more things a person can be told about. The pipeline that delivers them
-- is unchanged (ADR 0024, ADR 0026, ADR 0027).
ALTER TYPE "NotificationType" ADD VALUE 'MESSAGE_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE 'PLACEMENT_DECIDED';

CREATE TYPE "PlacementSlot" AS ENUM ('HERO', 'PICKED_SHELF');

CREATE TYPE "PlacementStatus" AS ENUM (
  'REQUESTED', 'COUNTERED', 'AGREED', 'LIVE', 'ENDED', 'DECLINED', 'WITHDRAWN'
);

CREATE TYPE "ThreadKind" AS ENUM ('PLACEMENT', 'SUPPORT');

CREATE TYPE "MessageAuthor" AS ENUM ('SELLER', 'ADMIN');

-- One seller on one side; a ROLE on the other. There is no admin user id on
-- this table on purpose: moderation is a shift, not an assignment, and a thread
-- owned by one moderator becomes unanswerable when that account is revoked.
CREATE TABLE "message_threads" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "kind" "ThreadKind" NOT NULL,
    "subject" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "sellerUnread" INTEGER NOT NULL DEFAULT 0,
    "adminUnread" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_threads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "author" "MessageAuthor" NOT NULL,
    -- Intentionally not a foreign key: "an admin who has since been deleted
    -- wrote this" must stay answerable. Same call as notification_deliveries.
    "authorUserId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "placement_requests" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "slot" "PlacementSlot" NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "offeredCents" INTEGER NOT NULL,
    "agreedCents" INTEGER,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "status" "PlacementStatus" NOT NULL DEFAULT 'REQUESTED',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "threadId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "placement_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "message_threads_sellerId_lastMessageAt_idx"
  ON "message_threads" ("sellerId", "lastMessageAt");

CREATE INDEX "message_threads_adminUnread_lastMessageAt_idx"
  ON "message_threads" ("adminUnread", "lastMessageAt");

CREATE INDEX "messages_threadId_createdAt_idx"
  ON "messages" ("threadId", "createdAt");

CREATE INDEX "placement_requests_status_slot_position_idx"
  ON "placement_requests" ("status", "slot", "position");

CREATE INDEX "placement_requests_sellerId_status_idx"
  ON "placement_requests" ("sellerId", "status");

-- One thread per request, so counter-offers and the agreed terms cannot drift
-- into two different conversations.
CREATE UNIQUE INDEX "placement_requests_threadId_key"
  ON "placement_requests" ("threadId");

-- THE LOAD-BEARING INDEX, and the reason this migration is hand-written.
--
-- Prisma cannot express a partial unique index, and this feature needs one: two
-- listings must never hold the same live slot. Without it, "check whether the
-- hero is free, then take it" is a read followed by a write, and two moderators
-- activating two hero agreements in the same instant both pass the check and
-- both succeed — which is how a homepage ends up with a non-deterministic
-- banner that changes on every request depending on row order.
--
-- With it, going live is `UPDATE ... SET status='LIVE' WHERE status='AGREED'`
-- and the constraint decides: one commits, the other raises a unique violation
-- and rolls back. The claim IS the permission to proceed, exactly as in
-- ADR 0012 (stock), ADR 0013 (payment) and ADR 0030 (payouts).
--
-- Partial, so the terminal states are unconstrained: a slot can hold any number
-- of ENDED or DECLINED rows, which is the history the admin screen reads.
CREATE UNIQUE INDEX "placement_live_slot"
  ON "placement_requests" ("slot", "position")
  WHERE "status" = 'LIVE';

ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "messages" ADD CONSTRAINT "messages_threadId_fkey"
  FOREIGN KEY ("threadId") REFERENCES "message_threads"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "placement_requests" ADD CONSTRAINT "placement_requests_listingId_fkey"
  FOREIGN KEY ("listingId") REFERENCES "listings"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "placement_requests" ADD CONSTRAINT "placement_requests_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "placement_requests" ADD CONSTRAINT "placement_requests_threadId_fkey"
  FOREIGN KEY ("threadId") REFERENCES "message_threads"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
