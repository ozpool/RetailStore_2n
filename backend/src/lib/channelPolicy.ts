import { prisma } from "./prisma";
import { DeliveryChannel, NotificationType } from "../generated/prisma/enums";

/**
 * Which channels each event goes to, and how a user overrides it.
 *
 * This table is the difference between notifications people trust and
 * notifications people mute. Every default below is an editorial decision, not
 * a technical one, and the reasoning is next to it.
 *
 * See docs/adr/0027-notification-consent-and-preferences.md
 */

export type ChannelDefault =
  /** Sent unless the user turned it off. */
  | "on"
  /** Not sent unless the user turned it on. */
  | "opt-in"
  /** Never sent on this channel, and not offered in settings. */
  | "off";

type Policy = Record<DeliveryChannel, ChannelDefault>;

/**
 * IN-APP IS NOT IN HERE. Preferences govern delivery, never the record: the
 * `notifications` row is written regardless, because it is what the app reads
 * and what makes "what happened to me" answerable independently of who was told
 * how. A preference that could erase it would break that.
 */
const POLICY: Record<NotificationType, Policy> = {
  /**
   * A seller wants to know they sold something, and wants it by email so there
   * is a record. SMS is opt-in rather than on: a standing subscription to every
   * future sale is a different thing from a message about one completed
   * transaction, and a busy seller would be paying us to spam them.
   */
  [NotificationType.SALE_MADE]: { EMAIL: "on", PUSH: "on", SMS: "opt-in" },

  /** Buyer, about a thing they are waiting for. */
  [NotificationType.ORDER_SHIPPED]: { EMAIL: "on", PUSH: "on", SMS: "off" },

  /**
   * No email. It is a confirmation of something the seller already knows is
   * coming, and mailing it is how the domain earns a filter rule.
   */
  [NotificationType.ORDER_DELIVERED]: { EMAIL: "off", PUSH: "on", SMS: "off" },

  /**
   * SMS ON BY DEFAULT. An item that was paid for is not coming, and there may
   * be a refund to check. This clears the bar of "needs to know now, away from
   * a screen" — one of only two events that do.
   */
  [NotificationType.ORDER_UNFULFILLABLE]: { EMAIL: "on", PUSH: "on", SMS: "on" },

  /** The other one. Money moved back; people notice, and they should hear it from us. */
  [NotificationType.REFUND_ISSUED]: { EMAIL: "on", PUSH: "on", SMS: "on" },

  /**
   * Push only. A five-star review is pleasant and not urgent, and a seller with
   * forty listings would get forty emails.
   */
  [NotificationType.REVIEW_RECEIVED]: { EMAIL: "off", PUSH: "on", SMS: "off" },

  [NotificationType.IDENTITY_VERIFIED]: { EMAIL: "on", PUSH: "on", SMS: "off" },
  [NotificationType.IDENTITY_REJECTED]: { EMAIL: "on", PUSH: "on", SMS: "off" },
  [NotificationType.LISTING_REMOVED]: { EMAIL: "on", PUSH: "on", SMS: "off" },

  /**
   * NO PUSH, DELIBERATELY. A suspended user cannot open the app, so a push
   * notification leads to a login screen that refuses them. Email leaves them
   * something to read and something to appeal against.
   */
  [NotificationType.ACCOUNT_SUSPENDED]: { EMAIL: "on", PUSH: "off", SMS: "off" },

  /** Push only: an answer to something they raised, not something to file. */
  [NotificationType.REPORT_RESOLVED]: { EMAIL: "off", PUSH: "on", SMS: "off" },

  /**
   * A reply arrived on a thread. Email ON, because a conversation with the
   * platform is exactly the kind of thing a seller needs to be able to find
   * again in three weeks, and push alone is gone the moment it is dismissed.
   *
   * SMS off. This is the boundary ADR 0027 drew and it holds here: only money
   * moving unexpectedly earns a text. A message can wait for a screen.
   */
  [NotificationType.MESSAGE_RECEIVED]: { EMAIL: "on", PUSH: "on", SMS: "off" },

  /**
   * A placement request was answered. Email ON for the same reason — the terms
   * that were agreed are a commercial record, and "what did we settle on" must
   * be answerable without opening the app.
   */
  [NotificationType.PLACEMENT_DECIDED]: { EMAIL: "on", PUSH: "on", SMS: "off" },
};

export function channelDefault(
  type: NotificationType,
  channel: DeliveryChannel
): ChannelDefault {
  return POLICY[type]?.[channel] ?? "off";
}

/**
 * Whether a channel is ever offered for a type.
 *
 * `off` means the product does not send this on this channel at all, so it does
 * not appear in the settings UI. Showing a switch that does nothing is worse
 * than showing nothing: it makes people think they have turned something on.
 */
export function isOffered(type: NotificationType, channel: DeliveryChannel): boolean {
  return channelDefault(type, channel) !== "off";
}

export type Decision =
  | { send: true }
  | { send: false; reason: string };

/**
 * Resolves one (user, type, channel) against the defaults and any explicit
 * preference.
 *
 * The order is: a channel we never send on, then the user's explicit choice,
 * then the default. An explicit row wins over the default in BOTH directions —
 * a user may turn on an opt-in channel and turn off an on-by-default one.
 */
export async function shouldSend(input: {
  userId: string;
  type: NotificationType;
  channel: DeliveryChannel;
}): Promise<Decision> {
  const fallback = channelDefault(input.type, input.channel);

  if (fallback === "off") {
    return { send: false, reason: `${input.channel} is not used for ${input.type}` };
  }

  const explicit = await prisma.notificationPreference.findUnique({
    where: {
      userId_type_channel: {
        userId: input.userId,
        type: input.type,
        channel: input.channel,
      },
    },
    select: { enabled: true },
  });

  if (explicit) {
    return explicit.enabled
      ? { send: true }
      : { send: false, reason: "turned off by the recipient" };
  }

  return fallback === "on"
    ? { send: true }
    : { send: false, reason: "opt-in, and not opted in" };
}

/**
 * Everything the settings page needs: every type that is offered on any
 * channel, with the effective value and whether it is a default or a choice.
 *
 * Reads all of one user's preferences in a single query rather than one per
 * switch — 33 round trips to render one page would be its own bug.
 */
export async function preferencesFor(userId: string) {
  const rows = await prisma.notificationPreference.findMany({
    where: { userId },
    select: { type: true, channel: true, enabled: true },
  });

  const explicit = new Map(rows.map((r) => [`${r.type}:${r.channel}`, r.enabled]));

  return Object.values(NotificationType).map((type) => ({
    type,
    channels: Object.values(DeliveryChannel)
      .filter((channel) => isOffered(type, channel))
      .map((channel) => {
        const choice = explicit.get(`${type}:${channel}`);
        return {
          channel,
          enabled: choice ?? channelDefault(type, channel) === "on",
          /** True when the value is the product's, not the user's. */
          isDefault: choice === undefined,
        };
      }),
  }));
}

/**
 * Records a choice. Upsert, so setting the same value twice is not an error and
 * a double-clicked switch cannot create two rows.
 */
export async function setPreference(input: {
  userId: string;
  type: NotificationType;
  channel: DeliveryChannel;
  enabled: boolean;
}): Promise<void> {
  if (!isOffered(input.type, input.channel)) {
    throw new Error(`${input.channel} is not offered for ${input.type}`);
  }

  await prisma.notificationPreference.upsert({
    where: {
      userId_type_channel: {
        userId: input.userId,
        type: input.type,
        channel: input.channel,
      },
    },
    create: { ...input },
    update: { enabled: input.enabled },
  });
}

/**
 * Turns off every optional channel for one user.
 *
 * "Optional" is the operative word: ACCOUNT_SUSPENDED and the money-adjacent
 * events stay on. Somebody unsubscribing from review notifications has not
 * asked to stop being told their refund went through, and a one-click
 * unsubscribe that silently disabled that would be a worse failure than the
 * mail it was meant to stop.
 */
export const ALWAYS_EMAILED: NotificationType[] = [
  NotificationType.REFUND_ISSUED,
  NotificationType.ORDER_UNFULFILLABLE,
  NotificationType.ACCOUNT_SUSPENDED,
];

export async function unsubscribeAllOptional(
  userId: string,
  channel: DeliveryChannel
): Promise<number> {
  const types = Object.values(NotificationType).filter(
    (type) => isOffered(type, channel) && !ALWAYS_EMAILED.includes(type)
  );

  for (const type of types) {
    await setPreference({ userId, type, channel, enabled: false });
  }

  return types.length;
}
