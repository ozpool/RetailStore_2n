# 28. Twilio for SMS, behind the same seam as payments and identity

- **Status:** Accepted — implemented in phase 4 of
  [plan 0001](../plans/0001-multi-channel-notifications.md).
- **Recorded:** 2026-09-06

## Context

[Plan 0001](../plans/0001-multi-channel-notifications.md) left the SMS provider
open: Twilio, AWS SNS, or a stub with the seam in place and a real provider
deferred. Phases 2 and 3 shipped email and web push, and SMS is the last
channel. The choice has to be made before the consumer can send anything.

SMS differs from the other two channels in ways that decide this:

- **Every message costs money.** Email through an existing SMTP relay and web
  push through a browser vendor are both effectively free per message. SMS is
  not, and a bug that sends a thousand of them has an invoice attached.
- **Delivery is regulated.** Consent is a legal requirement in most places this
  would operate, opt-out via STOP is mandatory, and the platform is the sender.
  Getting it wrong is not a deliverability problem, it is a fine.
- **Sender identity is per-country and non-trivial.** Alphanumeric sender IDs,
  short codes, long codes, and 10DLC registration differ by market, and a
  message from an unregistered sender is silently dropped by carriers rather
  than rejected by the API.

## Decision

**Twilio, reached over its REST API, behind `SMS_PROVIDER=stub|twilio`.**

### The seam, and why the default is the stub

Identical in shape to `PAYMENT_PROVIDER` ([ADR 0013](0013-payment-provider-seam.md))
and `KYC_PROVIDER` ([ADR 0006](0006-kyc-store-reference-not-document.md)), for
identical reasons: CI must never send a real message and must never need a
secret to pass, and a pull request from a fork must go green without either.

The stub is not a mock of an interface. It runs the entire path — preference
resolution, the ledger claim, the daily cap, quiet hours, the ledger settle —
and only the carrier is absent. It also returns the verification code from
`POST /notifications/phone/start`, which is what lets the suite and a local
developer finish the flow without a handset. Under `twilio` that field is null.

### Twilio over AWS SNS

SNS is cheaper per message and the account already implies an AWS relationship
for object storage. It loses on the two things that actually cost time here.

**Opt-out handling.** Twilio's Messaging Service handles STOP/START/HELP at the
provider, so a recipient who replies STOP is suppressed by Twilio even if a bug
in this codebase would have sent anyway. That is a second line of defence on the
one failure that is also unlawful. SNS has opt-out lists but they are per-origin
and considerably more of the correctness lives in application code.

**Error codes that mean something.** Twilio distinguishes "not a mobile number"
(21614) from "unsubscribed" (21610) from "cannot route" (21612), which is
exactly the information the retry ladder needs to decide whether a failure is
worth another rung. Without a usable taxonomy the honest default is to treat
every failure as transient, and retrying a STOP is the worst thing this system
could do.

The cost difference is real and is accepted. At this volume it is a rounding
error against the engineering time that a worse opt-out story would consume.

### The REST API, not the `twilio` SDK

Sending a message is one form-encoded POST with basic auth. The Stripe SDK earns
its dependency because Stripe's surface here is large — PaymentIntents, Refunds,
Identity — and because webhook signature verification is subtle enough that
hand-rolling it would be a bug farm. None of that applies to one endpoint. A
dependency that exists to save fifteen lines is fifteen lines of someone else's
supply chain, on a package that would be installed into every image.

This is a decision that reverses cheaply. If inbound messages, delivery-status
webhooks, or Verify are adopted later, the SDK becomes worth its weight and the
change is contained to `lib/smsProvider.ts`.

### A Messaging Service is preferred over a bare number

`TWILIO_MESSAGING_SERVICE_SID` takes precedence over `TWILIO_FROM_NUMBER`.
The service is what carries sender pools, per-country sender selection, and the
opt-out handling above. A bare number is supported because it is what a test
account has, and it is the configuration that will be outgrown first.

### Failures are classified in the provider adapter

`lib/smsProvider.ts` owns the list of Twilio codes that are permanent, because
it is the only file that knows what a code means. Everything not on that list is
transient — including codes never seen before, since a new code is far more
likely to be capacity than a permanently dead handset, and the costs are
asymmetric: an unnecessary retry wastes one message, a missing retry loses the
notification.

## Consequences

**A real secret exists in production that can spend money.** `TWILIO_AUTH_TOKEN`
is a password, not a publishable key. Anything holding it can send messages
billed to the account, which puts it in the same class as the Stripe secret key.

**Two guards exist that no other channel has.** A per-user daily cap and a quiet
hours window, both in `lib/consumers/sms.ts`. They are circuit breakers against
bugs rather than user preferences, and they suppress with a recorded reason so
the ledger can still answer "why did I not get a text".

**Quiet hours defer rather than drop.** A message caught by the window is
parked as `DEFERRED` with a `notBefore`, and `lib/deferredDeliveries.ts` sends
it when the window opens. It is a sweeper rather than a fourth rung on the retry
ladder because a rung waits by pausing its partition, and an eight-hour pause
holds that partition open all night for everything behind it. Past a maximum age
— default 24 hours, for the case where the sweeper itself was down — the message
settles `SUPPRESSED` with a reason instead, because a refund text two days late
re-alarms somebody about something already resolved.

**Quiet hours are the server's window, not the recipient's.** There is no
timezone column on `User`, so a user abroad is quiet during the server's night.
[Plan 0001 §6](../plans/0001-multi-channel-notifications.md) specifies the
recipient's timezone; closing it is a column captured at signup.

**E.164 normalisation here is shape-only.** It does not know which numbers
exist, and a country code with a national trunk zero left behind it passes. The
verification code is the real check, and it is a far better one than any prefix
table — but anything reading `lib/phone.ts` expecting full validation will be
disappointed. `libphonenumber-js` or Twilio Lookup is the upgrade path.

## Alternatives considered

**AWS SNS.** Cheaper, and already adjacent to the object storage account.
Rejected on opt-out handling and on error taxonomy, above. Worth revisiting if
volume ever makes the per-message difference material.

**Stub only, with a real provider deferred.** This was the conservative option
and it was tempting, because it defers the secret and the invoice. Rejected
because a seam that has never had a real implementation behind it is a seam that
does not work yet, and the discovery happens under deadline. The Twilio adapter
is what proves the shape is right.

**A `phone` column reused from `Address.phone`.** Rejected in
[ADR 0027](0027-notification-consent-and-preferences.md) and worth naming again
here, because it is the shortcut that looks free. That column is a delivery
contact for a parcel, unverified, and frequently a third party's number. Texting
it would message somebody who never consented and cannot unsubscribe.
