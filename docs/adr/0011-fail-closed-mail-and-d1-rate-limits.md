# ADR-0011: Fail-closed mail, and abuse limits in D1 rather than a rate-limit binding

Status: accepted
Date: 2026-09-10

## Context

`docs/waterlog-startup-packet.md` specifies the auth mechanism ("magic link + Apple/Google
OAuth", §Auth, and the Epic 0 row of §10) and nothing about what protects it. Two findings from a
security review of the deployed API and waitlist made the omission concrete.

**Sign-in links can end up in the log.** `getMailer` returned a `ConsoleMailer` whenever
`RESEND_API_KEY` was absent. That is the right behaviour locally — it is exactly how a developer
signs in without a mail provider — but the condition it keys on is "the secret is missing", and
"the secret is missing" is also what a botched production deploy looks like. A magic link is a
bearer credential: printing one to a Worker log hands an account to anyone who can read the log,
and nothing in the response would have said anything was wrong. The failure is silent, and it is
a full authentication bypass for every user who signs in during the window.

**`POST /api/auth/magic-link` had no limit of any kind.** Twelve consecutive requests all
returned 200 and created twelve live `login_tokens` rows. An unauthenticated caller could
therefore use us to flood any address with sign-in mail, burn the Resend quota, and grow the
table without bound — nothing ever pruned expired rows.

The waitlist had the milder version of the same shape: a `409` for an address already stored,
which turns a public form into a membership oracle, and a honeypot as its only throttle.

## Decision

**Mail fails closed.** The console mailer requires an explicit `ALLOW_CONSOLE_MAIL="true"`
opt-in. Absent both that and `RESEND_API_KEY`, `getMailer` throws and the route answers 503
having minted no token and logged no link. A real key always wins over the flag, so the flag
cannot downgrade a working environment. The flag lives in `workers/api/.dev.vars` (documented in
`.dev.vars.example`) and in the test harness's miniflare bindings — never in `wrangler.toml`,
because every environment that loads that file is a deployed one.

**Rate limiting lives in D1, not in Cloudflare's rate-limit binding.** The binding is the
platform-native answer and we are not using it, for one reason: it has no local implementation,
so a limit expressed through it cannot be exercised by the Miniflare test harness. An abuse
control nobody can test is an abuse control nobody can trust — the finding here was a limit that
did not exist, and the fix has to come with a test that fails without it. Migration 0007 adds a
`rate_limits` table holding a fixed-window counter per opaque bucket key, incremented by a single
`INSERT … ON CONFLICT … RETURNING` so concurrent requests cannot both read a stale count.

The quotas on `POST /api/auth/magic-link`:

| Bucket | Limit | Rationale |
| --- | --- | --- |
| per address | 5 / 15 min | A human who mistypes, retries, and asks twice more stays under it. A mailbox-flooding campaign against one victim does not. |
| per IP | 20 / 15 min | Four addresses at the per-address cap. Deliberately loose — households and offices share a NAT — and aimed at an enumeration sweep, not at one user. |

Requests with no `CF-Connecting-IP` share an `unknown` bucket rather than skipping the check.
Both quotas answer the same generic `429 {"error":"too many requests"}`, so the response never
reveals which limit tripped — the per-address one only trips for an address the caller already
named, and saying so would confirm nothing, but keeping the two indistinguishable costs nothing
either.

**Two hygiene rules ride along.** Minting a link supersedes that address's older unconsumed
tokens, so at most one live link exists per address: asking for a fresh link when the first has
not arrived is the natural thing to do, and it should not leave a widening set of working
credentials behind. And every mint and every verify runs one indexed `DELETE` against expired
rows — of tokens and of closed rate-limit windows — because nothing else prunes either table.

**The waitlist answers 200 whether the address is new or known**, still deduping on the KV key,
and counts submissions per IP in the same namespace under an `ip:` prefix with an `expirationTtl`.

## Consequences

- **A deploy without `RESEND_API_KEY` now breaks sign-in loudly instead of leaking quietly.**
  That is the trade and it is the right way round, but it means the secret is load-bearing: verify
  it is set on the API Worker before the next deploy, or magic-link sign-in returns 503.
- Local dev needs `ALLOW_CONSOLE_MAIL = "true"` in `workers/api/.dev.vars`. Without it the
  familiar "link printed in the wrangler console" flow stops working, which is the point.
- The per-address supersede changes observable behaviour: request two links, and only the second
  one works. Anyone who clicks the older mail gets the normal "invalid or expired" 401.
- `rate_limits` is a write on every magic-link request — two rows touched, plus a sweep. This is
  a sign-in endpoint, not a hot path.
- The fixed window lets a caller spend a full quota at the end of one window and another at the
  start of the next. A sliding window would cost a row per request; for a mail throttle the extra
  burst is not worth it.
- KV's eventual consistency lets a parallel burst slip a few writes past the waitlist counter.
  It is a speed bump on a public form, not an authorisation boundary.
- Still open: the other unauthenticated surfaces (`/api/auth/google`, `/api/auth/google/callback`)
  carry no quota. They cost us nothing per request and mint nothing, but the limiter is now
  general enough to cover them if that changes.
