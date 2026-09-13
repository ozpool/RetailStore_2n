import { prisma } from "./prisma";
import { enqueue, type TxClient } from "./outbox";
import { invalidate } from "./cache";
import { unreadKey } from "./cacheKeys";
import { MessageAuthor, NotificationType, ThreadKind } from "../generated/prisma/enums";

/**
 * Conversations between a seller and whoever is moderating.
 *
 * Every notification in this application before now was one-way: eleven event
 * types, three channels, no reply path anywhere. This is the first surface with
 * a person on both ends, and the asymmetry is the thing to understand — one
 * side is a seller, the other is a ROLE. `MessageThread` has no admin user id
 * on it; each `Message` records which side wrote it plus the user who did, for
 * audit.
 *
 * See docs/adr/0033-seller-admin-messaging.md
 */

/** Which side of a thread is acting. The admin side is shared by every moderator. */
export type ThreadSide = "SELLER" | "ADMIN";

/**
 * ONE TRANSACTION FOR THE MESSAGE AND THE EVENT THAT ANNOUNCES IT.
 *
 * This deliberately does NOT call `notify()`, and the reason is worth stating
 * because `notify()` is what every other caller in the codebase uses.
 *
 * `notify()` opens its own transaction and swallows its own errors, on the
 * grounds that failing to tell somebody their item sold must never roll back
 * the sale (ADR 0024). That is right for a sale: the sale is the important
 * thing and the notification is a side effect of it.
 *
 * Here the message IS the thing, and a message nobody is told about is worse
 * than a send that visibly failed — the seller would sit waiting for a reply to
 * something the moderator queue never showed. So the message, the unread
 * counters, the notification row and the outbox event commit together or not at
 * all, and a failure propagates to the caller so the UI can say "that didn't
 * send, try again".
 *
 * Returns the recipients so the caller can invalidate their badge caches AFTER
 * the commit — same ordering as `notifyMany`, for the same reason: a cache
 * invalidation that fails must not roll back the thing it was invalidating for.
 */
async function writeMessage(
  tx: TxClient,
  input: {
    threadId: string;
    subject: string;
    sellerUserId: string;
    author: MessageAuthor;
    authorUserId: string;
    body: string;
    shopName: string;
    /**
     * Defaults to MESSAGE_RECEIVED. Overridden by the placement library so one
     * action raises ONE notification: a counter-offer is a message AND a
     * commercial decision, and telling somebody twice about one event is how a
     * channel gets muted. See ADR 0034.
     */
    notificationType?: NotificationType;
  }
): Promise<{ messageId: string; recipientIds: string[] }> {
  const fromSeller = input.author === MessageAuthor.SELLER;

  const message = await tx.message.create({
    data: {
      threadId: input.threadId,
      author: input.author,
      authorUserId: input.authorUserId,
      body: input.body,
    },
    select: { id: true },
  });

  /**
   * The counter for the OTHER side goes up; this side's is untouched. Writing
   * both would zero the sender's badge as a side effect of sending, which is
   * correct by accident and wrong on purpose — reading is what clears a badge.
   */
  await tx.messageThread.update({
    where: { id: input.threadId },
    data: {
      lastMessageAt: new Date(),
      ...(fromSeller ? { adminUnread: { increment: 1 } } : { sellerUnread: { increment: 1 } }),
    },
  });

  /**
   * WHO HEARS ABOUT IT.
   *
   * A seller writing reaches every moderator, because the admin side of a
   * thread is a role and there is nobody it is assigned to. An admin writing
   * reaches exactly one person.
   *
   * Suspended admins are excluded: a notification whose link leads to a login
   * screen that refuses you is the same mistake ACCOUNT_SUSPENDED avoids by
   * having no push channel.
   */
  const recipients = fromSeller
    ? (
        await tx.user.findMany({
          where: { role: "ADMIN", suspendedAt: null },
          select: { id: true },
        })
      ).map((u) => u.id)
    : [input.sellerUserId];

  const type = input.notificationType ?? NotificationType.MESSAGE_RECEIVED;

  const title = fromSeller
    ? `${input.shopName} sent a message`
    : type === NotificationType.PLACEMENT_DECIDED
      ? `Your homepage placement request was answered`
      : `RetailStore_2n replied about "${input.subject}"`;

  for (const userId of recipients) {
    const notification = await tx.notification.create({
      data: {
        userId,
        type,
        title,
        /**
         * A snapshot, not a join. The notification has to stay readable when
         * the thread is closed or the message edited away, for the same reason
         * every other notification stores its own sentence (ADR 0024).
         */
        body: input.body.slice(0, 200),
        link: fromSeller ? `/admin/messages/${input.threadId}` : `/account/messages/${input.threadId}`,
      },
      select: { id: true, title: true, body: true, link: true },
    });

    await enqueue(tx, {
      type,
      userId,
      /** The thread, so a support query can trace every message about one conversation. */
      aggregateType: "message_thread",
      aggregateId: input.threadId,
      payload: {
        notificationId: notification.id,
        title: notification.title,
        body: notification.body,
        link: notification.link,
      },
    });
  }

  return { messageId: message.id, recipientIds: recipients };
}

export type OpenOutcome =
  | { opened: true; threadId: string; messageId: string }
  | { opened: false; reason: "no-seller" };

/**
 * A seller starts a conversation, or a moderator starts one with a seller.
 *
 * Exposed in a transaction-taking form as well, because a placement request and
 * the thread carrying its negotiation have to be one unit of work — a request
 * with no thread is unanswerable, and a thread with no request is noise in the
 * moderator queue (ADR 0034).
 */
export async function openThreadTx(
  tx: TxClient,
  input: {
    sellerId: string;
    kind: ThreadKind;
    subject: string;
    body: string;
    author: MessageAuthor;
    authorUserId: string;
  }
): Promise<{ threadId: string; messageId: string; recipientIds: string[] }> {
  const seller = await tx.sellerProfile.findUnique({
    where: { id: input.sellerId },
    select: { userId: true, shopName: true },
  });
  if (!seller) throw new Error(`no seller profile ${input.sellerId}`);

  const thread = await tx.messageThread.create({
    data: { sellerId: input.sellerId, kind: input.kind, subject: input.subject.trim() },
    select: { id: true },
  });

  const written = await writeMessage(tx, {
    threadId: thread.id,
    subject: input.subject.trim(),
    sellerUserId: seller.userId,
    author: input.author,
    authorUserId: input.authorUserId,
    body: input.body.trim(),
    shopName: seller.shopName ?? "A seller",
  });

  return { threadId: thread.id, ...written };
}

export async function openThread(input: {
  sellerId: string;
  kind: ThreadKind;
  subject: string;
  body: string;
  author: MessageAuthor;
  authorUserId: string;
}): Promise<OpenOutcome> {
  const exists = await prisma.sellerProfile.count({ where: { id: input.sellerId } });
  if (exists === 0) return { opened: false, reason: "no-seller" };

  const result = await prisma.$transaction((tx) => openThreadTx(tx, input));
  await invalidate(...result.recipientIds.map(unreadKey));
  return { opened: true, threadId: result.threadId, messageId: result.messageId };
}

/**
 * A reply written inside somebody else's transaction.
 *
 * Exists for the placement library: a counter-offer changes the request's terms
 * AND says so in the thread, and those two must not be separable — a status
 * that moved with no message is a seller told their terms changed without being
 * told what to. The caller is responsible for badge invalidation after commit,
 * which is why the recipients come back.
 */
export async function postMessageTx(
  tx: TxClient,
  input: {
    threadId: string;
    author: MessageAuthor;
    authorUserId: string;
    body: string;
    notificationType?: NotificationType;
  }
): Promise<{ messageId: string; recipientIds: string[] }> {
  const thread = await tx.messageThread.findUniqueOrThrow({
    where: { id: input.threadId },
    select: { subject: true, seller: { select: { userId: true, shopName: true } } },
  });

  return writeMessage(tx, {
    threadId: input.threadId,
    subject: thread.subject,
    sellerUserId: thread.seller.userId,
    author: input.author,
    authorUserId: input.authorUserId,
    body: input.body.trim(),
    shopName: thread.seller.shopName ?? "A seller",
    notificationType: input.notificationType,
  });
}

export type PostOutcome =
  | { posted: true; messageId: string }
  | { posted: false; reason: "no-thread" | "closed" };

/** A reply on an existing thread. */
export async function postMessage(input: {
  threadId: string;
  author: MessageAuthor;
  authorUserId: string;
  body: string;
}): Promise<PostOutcome> {
  const thread = await prisma.messageThread.findUnique({
    where: { id: input.threadId },
    select: {
      id: true,
      subject: true,
      closedAt: true,
      seller: { select: { userId: true, shopName: true } },
    },
  });

  if (!thread) return { posted: false, reason: "no-thread" };
  /**
   * A closed thread refuses new messages rather than reopening itself. Silent
   * reopening means a moderator who closed a resolved conversation finds it
   * back in the queue with no record of why.
   */
  if (thread.closedAt !== null) return { posted: false, reason: "closed" };

  const written = await prisma.$transaction((tx) =>
    writeMessage(tx, {
      threadId: thread.id,
      subject: thread.subject,
      sellerUserId: thread.seller.userId,
      author: input.author,
      authorUserId: input.authorUserId,
      body: input.body.trim(),
      shopName: thread.seller.shopName ?? "A seller",
    })
  );

  await invalidate(...written.recipientIds.map(unreadKey));
  return { posted: true, messageId: written.messageId };
}

/**
 * Opening a thread clears that side's badge.
 *
 * Zeroed rather than decremented: the side has just seen everything, so the
 * count is zero by definition and a decrement would need to know how many were
 * displayed. Returns how many were cleared, which is what lets a test assert
 * the counter was actually carrying something.
 */
export async function markRead(threadId: string, side: ThreadSide): Promise<number> {
  const before = await prisma.messageThread.findUnique({
    where: { id: threadId },
    select: { sellerUnread: true, adminUnread: true },
  });
  if (!before) return 0;

  const had = side === "SELLER" ? before.sellerUnread : before.adminUnread;
  if (had === 0) return 0;

  await prisma.messageThread.update({
    where: { id: threadId },
    data: side === "SELLER" ? { sellerUnread: 0 } : { adminUnread: 0 },
  });
  return had;
}

/**
 * Closing is an admin action and it is reversible.
 *
 * A conditional `UPDATE` on `closedAt`, so two moderators closing the same
 * thread produce one change and one no-op rather than two audit entries.
 */
export async function closeThread(threadId: string): Promise<boolean> {
  const closed = await prisma.messageThread.updateMany({
    where: { id: threadId, closedAt: null },
    data: { closedAt: new Date() },
  });
  return closed.count === 1;
}

export async function reopenThread(threadId: string): Promise<boolean> {
  const reopened = await prisma.messageThread.updateMany({
    where: { id: threadId, closedAt: { not: null } },
    data: { closedAt: null },
  });
  return reopened.count === 1;
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

const threadSummary = {
  id: true,
  kind: true,
  subject: true,
  lastMessageAt: true,
  closedAt: true,
  sellerUnread: true,
  adminUnread: true,
  createdAt: true,
} as const;

export async function threadsForSeller(sellerId: string) {
  const rows = await prisma.messageThread.findMany({
    where: { sellerId },
    select: { ...threadSummary, placement: { select: { id: true, status: true, slot: true } } },
    orderBy: { lastMessageAt: "desc" },
    take: 100,
  });
  return rows.map((t) => ({ ...t, unread: t.sellerUnread }));
}

/**
 * The moderator queue.
 *
 * Unanswered first, then by activity. `adminUnread > 0` is the whole definition
 * of "needs somebody" — there is no assignment and no SLA, which ADR 0033 is
 * explicit about: this is not a support desk.
 */
export async function threadsForAdmin(opts: { unansweredOnly?: boolean } = {}) {
  const rows = await prisma.messageThread.findMany({
    where: {
      ...(opts.unansweredOnly ? { adminUnread: { gt: 0 } } : {}),
      closedAt: null,
    },
    select: {
      ...threadSummary,
      seller: { select: { id: true, shopName: true } },
      placement: { select: { id: true, status: true, slot: true, offeredCents: true } },
    },
    orderBy: [{ adminUnread: "desc" }, { lastMessageAt: "desc" }],
    take: 100,
  });
  return rows.map((t) => ({ ...t, unread: t.adminUnread }));
}

/**
 * One thread with its messages.
 *
 * `side` scopes it: a seller asking for somebody else's thread gets null, so
 * the route answers 404 rather than 403 — the same policy as sales, payouts and
 * returns, so an id cannot be used to ask whether a thread exists.
 */
export async function threadDetail(threadId: string, side: ThreadSide, sellerId?: string) {
  const thread = await prisma.messageThread.findFirst({
    where: {
      id: threadId,
      ...(side === "SELLER" ? { sellerId } : {}),
    },
    select: {
      ...threadSummary,
      seller: { select: { id: true, shopName: true } },
      placement: {
        select: {
          id: true,
          status: true,
          slot: true,
          position: true,
          offeredCents: true,
          agreedCents: true,
          startsAt: true,
          endsAt: true,
          listing: { select: { id: true, title: true, slug: true } },
        },
      },
      messages: {
        select: { id: true, author: true, body: true, createdAt: true },
        orderBy: { createdAt: "asc" },
        take: 500,
      },
    },
  });
  if (!thread) return null;
  return { ...thread, unread: side === "SELLER" ? thread.sellerUnread : thread.adminUnread };
}

/** For the seller nav badge and the admin nav badge. */
export async function unreadThreadCount(side: ThreadSide, sellerId?: string): Promise<number> {
  return prisma.messageThread.count({
    where:
      side === "SELLER"
        ? { sellerId, sellerUnread: { gt: 0 }, closedAt: null }
        : { adminUnread: { gt: 0 }, closedAt: null },
  });
}
