import { PermanentFailure, deliver } from "../deliveryLedger";
import { sendNotificationEmail } from "../mailer";
import { prisma } from "../prisma";
import { unsubscribeHeaders, unsubscribeUrl } from "../unsubscribe";
import type { NotificationConsumer } from "../consumers";
import { DeliveryChannel } from "../../generated/prisma/enums";

/**
 * The email channel.
 *
 * Everything that makes this safe lives in deliveryLedger.deliver(): resolve
 * preferences, claim the delivery, send, settle. This file is the part that
 * knows about email specifically — where the address comes from, what the link
 * should say, and which failures are permanent.
 */

function frontendOrigin(): string {
  return process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";
}

/**
 * Notification links are stored as paths ("/orders/abc"), because the app
 * navigates within itself. An email is read outside the app, so it needs the
 * origin — and the origin is read at send time rather than baked in, so one
 * deployment's links cannot end up pointing at another's.
 */
function absolute(link: string | null): string | null {
  if (!link) return null;
  if (/^https?:\/\//i.test(link)) return link;
  return `${frontendOrigin()}${link.startsWith("/") ? "" : "/"}${link}`;
}

/**
 * What the button says.
 *
 * Named for the destination rather than the action, because the reader is
 * deciding whether to leave their inbox. "View" tells them nothing; "See the
 * order" tells them where they will land.
 */
function actionLabel(link: string | null): string {
  if (!link) return "Open RetailStore_2n";
  if (link.startsWith("/orders/")) return "See the order";
  if (link.startsWith("/seller/sales")) return "See your sales";
  if (link.startsWith("/seller/verify")) return "Check verification";
  if (link.startsWith("/seller")) return "Open your shop";
  if (link.startsWith("/listing/")) return "See the listing";
  return "Open RetailStore_2n";
}

export const emailConsumer: NotificationConsumer = {
  group: "email-worker",
  channel: DeliveryChannel.EMAIL,

  async handle(event, opts) {
    return deliver(event, DeliveryChannel.EMAIL, async () => {
      /**
       * Read at send time, not carried in the event.
       *
       * The address can change between the notification being written and the
       * email going out, and the current address is the one that should get it.
       * This is the one thing here that is deliberately NOT snapshotted — the
       * text is a fact about the past, but the recipient is a fact about now.
       */
      const user = await prisma.user.findUnique({
        where: { id: event.userId },
        select: { email: true, emailVerified: true, suspendedAt: true },
      });

      if (!user) {
        // The account is gone. No amount of retrying grows one back.
        throw new PermanentFailure(`no such user ${event.userId}`);
      }

      /**
       * NOT A SUPPRESSION, AND NOT A PREFERENCE.
       *
       * An unverified address is one nobody has proved they control. Mailing it
       * is how this domain ends up sending to typos and to addresses somebody
       * else owns, which is a deliverability problem and a privacy one — order
       * details would go to a stranger.
       *
       * It fails rather than suppresses because suppression means "the
       * recipient chose this", and they did not.
       */
      if (!user.emailVerified) {
        /**
         * Permanent for THIS event. Verification is a user action, not
         * something that resolves on its own within fifteen minutes, so the
         * ladder would burn three rungs to reach the same answer. If they
         * verify later, later notifications go out normally.
         */
        throw new PermanentFailure(`email not verified for ${event.userId}`);
      }

      const token = {
        userId: event.userId,
        channel: DeliveryChannel.EMAIL,
        scope: event.type,
      };

      const result = await sendNotificationEmail({
        to: user.email,
        title: event.payload.title,
        body: event.payload.body,
        actionUrl: absolute(event.payload.link),
        actionLabel: actionLabel(event.payload.link),
        unsubscribeUrl: unsubscribeUrl(token),
        headers: unsubscribeHeaders(token),
      });

      return { providerMessageId: result.messageId };
    }, opts);
  },
};
