import { prisma, requireServices } from "../lib/db";
import { main, wireInterrupt, cleanupOnInterrupt } from "../lib/harness";
import {
  closeThread,
  markRead,
  openThread,
  postMessage,
  reopenThread,
  threadDetail,
  threadsForAdmin,
  threadsForSeller,
  unreadThreadCount,
} from "../../src/lib/messaging";
import { MessageAuthor, NotificationType, ThreadKind } from "../../src/generated/prisma/enums";

/**
 * Seller-admin conversations.
 *
 * WHAT THIS SUITE IS FOR
 * This is the first two-way surface in the application, and the two things that
 * can quietly be wrong about it are both invisible from the UI:
 *
 *   1. THE EVENT AND THE MESSAGE MUST COMMIT TOGETHER. `lib/messaging` does not
 *      use `notify()` — it writes the notification and the outbox row inside
 *      its own transaction, precisely so a message cannot exist that nobody was
 *      told about. If that ever regresses to a second transaction, nothing
 *      fails: the message appears, the seller waits for a reply, and the
 *      moderator queue never shows it.
 *
 *   2. THE ADMIN SIDE IS A ROLE, NOT A PERSON. A seller writing has to reach
 *      every moderator, because there is nobody the thread is assigned to. Get
 *      that wrong by notifying one arbitrary admin and the feature works for
 *      whoever happens to be first in the table.
 *
 * Both are asserted by counting rows, not by reading code.
 *
 * See docs/adr/0033-seller-admin-messaging.md
 */

const TAG = `rs2.msg.${Date.now()}`;

let sellerUserId = "";
let sellerId = "";
let otherSellerId = "";
let adminA = "";
let adminB = "";
let suspendedAdmin = "";
const threadIds: string[] = [];

/** Every outbox row raised for one thread, which is the aggregate they carry. */
async function outboxFor(threadId: string) {
  return prisma.outboxEvent.findMany({
    where: { aggregateType: "message_thread", aggregateId: threadId },
    select: { type: true, userId: true, payload: true },
  });
}

async function notificationsFor(threadId: string) {
  return prisma.notification.findMany({
    where: { type: NotificationType.MESSAGE_RECEIVED, link: { contains: threadId } },
    select: { userId: true, title: true, body: true, link: true },
  });
}

void main(
  "seller-admin messaging",

  async (t) => {
    await requireServices({ api: false, db: true });

    /* ---- fixture: one seller, two live moderators, one suspended ---- */

    const sellerUser = await prisma.user.create({
      data: {
        email: `${TAG}.seller@retailstore-2n.test`,
        name: "Messaging Seller",
        passwordHash: "not-a-real-hash",
        emailVerified: true,
        isSeller: true,
      },
      select: { id: true },
    });
    sellerUserId = sellerUser.id;

    const profile = await prisma.sellerProfile.create({
      data: { userId: sellerUserId, shopName: "The Mended Room" },
      select: { id: true },
    });
    sellerId = profile.id;

    const otherUser = await prisma.user.create({
      data: {
        email: `${TAG}.other@retailstore-2n.test`,
        name: "Unrelated Seller",
        passwordHash: "not-a-real-hash",
        emailVerified: true,
        isSeller: true,
      },
      select: { id: true },
    });
    const otherProfile = await prisma.sellerProfile.create({
      data: { userId: otherUser.id, shopName: "Somebody Else" },
      select: { id: true },
    });
    otherSellerId = otherProfile.id;

    for (const [label, suspended] of [
      ["a", false],
      ["b", false],
      ["suspended", true],
    ] as const) {
      const u = await prisma.user.create({
        data: {
          email: `${TAG}.admin-${label}@retailstore-2n.test`,
          name: `Moderator ${label}`,
          passwordHash: "not-a-real-hash",
          emailVerified: true,
          role: "ADMIN",
          suspendedAt: suspended ? new Date() : null,
        },
        select: { id: true },
      });
      if (label === "a") adminA = u.id;
      else if (label === "b") adminB = u.id;
      else suspendedAdmin = u.id;
    }

    /**
     * Other suites and the seed leave admins behind, and "every moderator" means
     * every one in the database rather than only the two created here. Captured
     * now so the fan-out assertions compare against the real population.
     */
    const liveAdmins = await prisma.user.findMany({
      where: { role: "ADMIN", suspendedAt: null },
      select: { id: true },
    });
    const liveAdminIds = new Set(liveAdmins.map((a) => a.id));

    /* ---- 1. opening a thread ---- */

    t.section("1. one message, one event per recipient, all in one transaction");

    const opened = await openThread({
      sellerId,
      kind: ThreadKind.PLACEMENT,
      subject: "Homepage placement for the teak sideboard",
      body: "Could I appear on the homepage for a week? I can pay $40 for the hero.",
      author: MessageAuthor.SELLER,
      authorUserId: sellerUserId,
    });

    t.check(opened.opened, "a seller can open a thread");
    if (!opened.opened) return;
    threadIds.push(opened.threadId);

    const events = await outboxFor(opened.threadId);
    const notes = await notificationsFor(opened.threadId);

    t.check(
      events.length === liveAdminIds.size,
      "one outbox row per live moderator",
      `${events.length} event(s), ${liveAdminIds.size} live moderator(s)`
    );
    t.check(
      notes.length === liveAdminIds.size,
      "and one notification per live moderator",
      `${notes.length} notification(s)`
    );
    t.check(
      events.length > 0 && events.every((e) => liveAdminIds.has(e.userId)),
      "every event is addressed to a moderator"
    );
    t.check(
      !events.some((e) => e.userId === suspendedAdmin),
      "a suspended moderator is not told — the link would refuse them"
    );
    t.check(
      events.every((e) => e.type === NotificationType.MESSAGE_RECEIVED),
      "raised as MESSAGE_RECEIVED"
    );
    t.check(
      notes.every((n) => n.link === `/admin/messages/${opened.threadId}`),
      "linked to the admin view of the thread"
    );
    t.check(
      notes.every((n) => (n.body ?? "").startsWith("Could I appear on the homepage")),
      "the notification carries a snapshot of the message, not a join"
    );

    /**
     * The event is in the same transaction as the message, and a count cannot
     * prove a transaction on its own. What it can prove is that neither exists
     * without the other, which is the failure this is guarding against: a
     * second transaction that fails leaves the message with no event at all.
     */
    const messageCount = await prisma.message.count({ where: { threadId: opened.threadId } });
    t.check(messageCount === 1, "exactly one message on the new thread");
    t.check(
      events.length > 0 && messageCount > 0,
      "message and event both landed — neither exists without the other"
    );

    /* ---- 2. the counters ---- */

    t.section("2. writing bumps the other side, never your own");

    const afterOpen = await prisma.messageThread.findUniqueOrThrow({
      where: { id: opened.threadId },
      select: { sellerUnread: true, adminUnread: true, closedAt: true },
    });
    t.check(afterOpen.adminUnread === 1, "the admin side has one unread", `got ${afterOpen.adminUnread}`);
    t.check(
      afterOpen.sellerUnread === 0,
      "the sender's own badge stays at zero",
      `got ${afterOpen.sellerUnread}`
    );

    const replied = await postMessage({
      threadId: opened.threadId,
      author: MessageAuthor.ADMIN,
      authorUserId: adminA,
      body: "We can do the hero for a week at $40. Shall we start Monday?",
    });
    t.check(replied.posted, "a moderator can reply");

    const afterReply = await prisma.messageThread.findUniqueOrThrow({
      where: { id: opened.threadId },
      select: { sellerUnread: true, adminUnread: true },
    });
    t.check(afterReply.sellerUnread === 1, "the seller now has one unread");
    t.check(
      afterReply.adminUnread === 1,
      "and the admin side is unchanged by its own reply",
      `got ${afterReply.adminUnread}`
    );

    const sellerNotes = await prisma.notification.count({
      where: { userId: sellerUserId, link: `/account/messages/${opened.threadId}` },
    });
    t.check(sellerNotes === 1, "the reply notified exactly the seller", `got ${sellerNotes}`);

    /* ---- 3. reading ---- */

    t.section("3. reading clears one side only");

    const cleared = await markRead(opened.threadId, "SELLER");
    t.check(cleared === 1, "marking read reports what it cleared", `cleared ${cleared}`);

    const afterRead = await prisma.messageThread.findUniqueOrThrow({
      where: { id: opened.threadId },
      select: { sellerUnread: true, adminUnread: true },
    });
    t.check(afterRead.sellerUnread === 0, "the seller's badge is zero");
    t.check(afterRead.adminUnread === 1, "the admin badge is untouched by the seller reading");

    t.check(
      (await markRead(opened.threadId, "SELLER")) === 0,
      "reading an already-read thread clears nothing and says so"
    );

    t.check(
      (await unreadThreadCount("SELLER", sellerId)) === 0,
      "the seller's nav badge counts zero threads"
    );
    t.check(
      (await unreadThreadCount("ADMIN")) >= 1,
      "the admin nav badge counts at least this thread"
    );

    /* ---- 4. closing ---- */

    t.section("4. closing is a claim, and a closed thread refuses messages");

    t.check(await closeThread(opened.threadId), "closing succeeds once");
    t.check(
      !(await closeThread(opened.threadId)),
      "closing again changes nothing — a conditional UPDATE, not a blind write"
    );

    const intoClosed = await postMessage({
      threadId: opened.threadId,
      author: MessageAuthor.SELLER,
      authorUserId: sellerUserId,
      body: "One more thing before you go — is Tuesday possible instead?",
    });
    t.check(
      !intoClosed.posted && intoClosed.reason === "closed",
      "a closed thread refuses a message rather than silently reopening",
      JSON.stringify(intoClosed)
    );

    const eventsAfterRefusal = await outboxFor(opened.threadId);
    t.check(
      eventsAfterRefusal.length === events.length + 1,
      "and raised no event for the message it refused",
      `${eventsAfterRefusal.length} vs ${events.length + 1} expected`
    );

    t.check(await reopenThread(opened.threadId), "reopening succeeds");
    t.check(!(await reopenThread(opened.threadId)), "reopening twice is a no-op");

    /* ---- 5. scoping ---- */

    t.section("5. a thread belongs to one seller");

    const mine = await threadDetail(opened.threadId, "SELLER", sellerId);
    t.check(mine !== null, "the owning seller can read it");
    t.check(
      (mine?.messages.length ?? 0) === 2,
      "with both messages in order",
      `got ${mine?.messages.length ?? 0}`
    );
    t.check(
      mine?.messages[0]?.author === MessageAuthor.SELLER &&
        mine?.messages[1]?.author === MessageAuthor.ADMIN,
      "oldest first, and each message knows which side wrote it"
    );

    t.check(
      (await threadDetail(opened.threadId, "SELLER", otherSellerId)) === null,
      "another seller gets null, so the route can answer 404 rather than 403"
    );
    t.check(
      (await threadDetail(opened.threadId, "ADMIN")) !== null,
      "and any moderator can read it, because the admin side is a role"
    );

    const sellerList = await threadsForSeller(sellerId);
    t.check(sellerList.length === 1, "the seller sees their own thread", `got ${sellerList.length}`);
    t.check(
      (await threadsForSeller(otherSellerId)).length === 0,
      "and not somebody else's"
    );

    const adminList = await threadsForAdmin({ unansweredOnly: true });
    t.check(
      adminList.some((x) => x.id === opened.threadId),
      "the unanswered queue includes a thread with an unread admin counter"
    );

    /* ---- 6. missing things ---- */

    t.section("6. the failure paths answer rather than throw");

    const noSeller = await openThread({
      sellerId: "00000000-0000-0000-0000-000000000000",
      kind: ThreadKind.SUPPORT,
      subject: "Nobody",
      body: "This should not open a thread at all.",
      author: MessageAuthor.SELLER,
      authorUserId: sellerUserId,
    });
    t.check(
      !noSeller.opened && noSeller.reason === "no-seller",
      "opening a thread for a seller that does not exist is answered, not thrown"
    );

    const noThread = await postMessage({
      threadId: "00000000-0000-0000-0000-000000000000",
      author: MessageAuthor.ADMIN,
      authorUserId: adminB,
      body: "Into the void, which should be refused politely.",
    });
    t.check(
      !noThread.posted && noThread.reason === "no-thread",
      "posting into a thread that does not exist is answered, not thrown"
    );
  },

  /* ---- cleanup ---- */
  async () => {
    for (const id of threadIds) {
      await prisma.outboxEvent.deleteMany({
        where: { aggregateType: "message_thread", aggregateId: id },
      });
      await prisma.notification.deleteMany({ where: { link: { contains: id } } });
    }
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  }
);

wireInterrupt();
cleanupOnInterrupt(async () => {
  for (const id of threadIds) {
    await prisma.outboxEvent.deleteMany({
      where: { aggregateType: "message_thread", aggregateId: id },
    });
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
});
