# 4. Length + breach check instead of composition rules

- **Status:** Accepted
- **Recorded:** 2026-08-22

## Context

The reflexive password policy is "at least 8 characters, one uppercase, one
lowercase, one digit, one symbol".

`P@ssw0rd1` satisfies it completely. It also appears in essentially every
breach corpus ever published. The rule measures a property that does not
correlate with resistance to the attacks that actually happen — credential
stuffing and dictionary attacks against leaked hashes.

Composition rules also push users toward predictable substitutions
(`a`→`@`, `o`→`0`, `!` appended) that cracking tools model directly, and toward
reuse, because a password satisfying four constraints is hard to invent twice.

NIST SP 800-63B dropped composition requirements and mandatory rotation, and
recommends checking candidates against known-compromised lists instead. GitHub
and Apple do the same.

## Decision

Two rules:

1. **Minimum 12 characters.** No composition requirements.
2. **Rejected if it appears in known breach corpora**, via the Pwned Passwords
   API.

The breach check uses **k-anonymity**: the first 5 characters of the SHA-1 hash
are sent, the API returns every matching suffix, and the comparison happens
locally. The password — and its full hash — never leave the server.

The check **fails open**. If the API is unreachable, signup proceeds. Blocking
registration because a third party is down trades a real availability outage for
a marginal security gain.

Storage is bcrypt at cost 12.

## Consequences

- `correct horse battery staple` is accepted; `P@ssw0rd1` is not. That inverts
  the usual outcome and is the point.
- Passphrases become viable, which favours length over symbol-juggling.
- A third-party dependency sits in the signup path, mitigated by failing open.
- One outbound HTTPS request per signup, plus ~50 ms.
- The error must be specific — "this password appeared in a data breach, choose
  another" — or it reads as an arbitrary rejection.

## Alternatives considered

**Classic composition rules.** Familiar to users and reviewers, and measures the
wrong thing. Blocks `correct horse battery staple` while allowing `P@ssw0rd1`.

**Length only.** Most of the benefit, no dependency, but accepts
`123456789012` and other long-yet-known passwords.

**A local breach wordlist.** No network dependency, but the useful corpus is
hundreds of millions of hashes; shipping and updating it is worse than one
k-anonymity request.

**zxcvbn strength estimation.** Good complement — it catches keyboard walks and
common patterns — but it estimates guessability rather than knowing what has
actually leaked. Worth adding alongside, not instead.
