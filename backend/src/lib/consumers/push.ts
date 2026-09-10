import { NothingToDeliverTo, deliver } from "../deliveryLedger";
import { isPushConfigured, sendPushToUser } from "../push";
import type { NotificationConsumer } from "../consumers";
import { DeliveryChannel } from "../../generated/prisma/enums";

/**
 * The push channel.
 *
 * As with email, everything that makes this safe is in
 * deliveryLedger.deliver(): resolve preferences, claim, send, settle. This file
 * knows about push specifically — that a user has zero or many devices, and
 * that having none is not a failure.
 */
export const pushConsumer: NotificationConsumer = {
  group: "push-worker",
  channel: DeliveryChannel.PUSH,

  async handle(event, opts) {
    return deliver(event, DeliveryChannel.PUSH, async () => {
      /**
       * SUPPRESSED, NOT FAILED. Without keys nobody can subscribe, so this is
       * "there is no push channel here" rather than "push broke". Recording it
       * as a failure would paint the ledger red for a feature that was simply
       * never switched on.
       */
      if (!isPushConfigured()) {
        throw new NothingToDeliverTo("push is not configured on this server");
      }

      const result = await sendPushToUser(event.userId, {
        title: event.payload.title,
        body: event.payload.body,
        url: event.payload.link,
        /**
         * Collapse key. A second notification with the same tag replaces the
         * first on the device rather than stacking, so a redelivery that
         * somehow got past the ledger still shows once.
         */
        tag: event.eventId,
      });

      // The ordinary state of most accounts: signed in, never granted
      // permission in any browser. Not an error, and not a preference.
      if (result.sent === 0) {
        throw new NothingToDeliverTo("no devices subscribed");
      }

      /**
       * There is no provider message id — Web Push returns a 201 with no body,
       * so there is nothing to record. Left null rather than invented: a
       * reference that cannot be looked up anywhere is worse than none.
       */
      return { providerMessageId: null };
    }, opts);
  },
};
