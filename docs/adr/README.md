# Architecture Decision Records

Each file records one decision that was not obvious, together with the
alternatives that were rejected and why. The point is that a future reader —
including a future me — can tell the difference between a deliberate choice and
an accident, and knows what would have to change for the decision to be
revisited.

Format follows [Michael Nygard's template](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).
Records are immutable: a decision that changes gets a new record that supersedes
the old one, rather than an edit.

> These were written retroactively, in one pass, after the features they
> describe were built. The decisions and their reasoning are real — the
> *documents* were not written at decision time, so treat the dates as "recorded
> on" rather than "decided on".

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-access-and-refresh-tokens.md) | Access + rotating refresh tokens with reuse detection | Accepted |
| [0002](0002-bff-proxy.md) | Next.js as a BFF instead of direct browser→API calls | Accepted |
| [0003](0003-unified-account.md) | One account type; selling is a capability | Accepted |
| [0004](0004-password-policy.md) | Length + breach check instead of composition rules | Accepted |


## Adding one

Copy the structure of any existing record, take the next number, and add a row
above. Worth recording when: the choice has more than one defensible answer, it
is expensive to reverse, or someone would otherwise be tempted to "fix" it.
