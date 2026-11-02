# SimSoccer Betting Space Architecture

**Status:** Product and engineering specification; authenticated play-money placement and ticket history are implemented
**Scope:** Pre-match market browsing, reusable booking codes, authenticated play-money bet placement, ticket history, settlement, and single-ticket lookup by access code
**Out of scope:** In-play odds, cash-out, real-money gambling, and mainnet deposits

## 1. Product Boundary

SimSoccer is a persistent virtual football world. Its simulation is authoritative for fixtures, match events, statistics, and final results. The betting space consumes this data; it must not influence the match engine, its random stream, event order, final score, or team evolution.

The betting space is a house-book product, not an exchange. SimSoccer publishes its own prices and later accepts bets against those prices. It does not expose a user-to-user back/lay order book or matched liquidity.

The application can be organized as a modular monolith initially, but betting must have explicit boundaries: a market-pricing domain, public market/booking APIs, a betting worker for market lifecycle and settlement work, and a separate frontend route. The simulation may publish or persist world facts; it must not call wallet or bet-placement logic.

## 2. Product Decisions Captured

- The initial objective is play-money development. Real-money use would require a separate legal, payments, identity, fraud, and jurisdictional review.
- An opt-in devnet-only SOL-to-credit prototype is documented in [SOLANA-CREDITS-PAYMENTS.md](./SOLANA-CREDITS-PAYMENTS.md). It does not enable mainnet deposits or change betting and settlement; a payment rail does not by itself make paid wagering legally permissible.
- Users may browse markets and build a slip without signing in. Placing a play-money bet requires a signed-in account and an adequately funded wallet.
- A **booking code** is a public, reusable reference to a not-yet-placed selection slip. It does not represent a wager, reserve odds, reserve a balance, or guarantee future availability.
- A **bet slip ID** is created only after a bet is accepted. It identifies the persisted wager, its accepted odds, stake, potential return, and later settlement. Never label a booking code as a bet slip ID or coupon.
- An accepted bet receives a separate 144-bit ticket access code. The browser generates it with the Web Crypto API, the API stores only its SHA-256 hash, and the receipt shows it once with a copy action. Anyone holding the code can read only that ticket's non-account details; lookup is rate-limited and returns the same not-found response for malformed and unknown codes. The code is distinct from both the booking code and the database bet ID.
- Signed-in users can review their latest 100 tickets on `/bets`, separated into Open and Settled. Signed-out users can use the same page to look up one ticket by its access code. Bet placement remains account-only.
- Selections can span the three leagues, provided they belong to the same shared world round.
- The first multiple type is a straight accumulator: all selections must win. A slip can contain at most one selection per fixture in this phase. Same-fixture Bet Builder pricing is explicitly deferred.
- Pre-match markets for a shared round close one minute before the earliest kickoff in that round. This is a server-side cutoff; a browser countdown is informational only.
- An unavailable or suspended leg makes the loaded booking slip unavailable as a whole until the user removes or replaces that selection. Loading a code must never silently drop a leg or turn it into a bet.
- True in-play betting means accepting bets while a match is running with changing prices. It is not included in the pre-match rollout. It requires event-triggered suspensions, pricing, replay protection, and capacity testing as its own phase.

## 3. Terms

| Term | Meaning |
| --- | --- |
| Fixture | One scheduled match in a league season and round. |
| Market | A question about one fixture, such as 1X2 or Total Goals 2.5. |
| Outcome | One possible selection within a market, such as Home, Draw, Over, or Under. |
| Price version | An immutable version of the odds published for an outcome. |
| Selection | A chosen outcome and its fixture/market identity. |
| Booking slip | A saved, unplaced set of selections, retrievable by booking code. |
| Bet / accepted ticket | A funded wager accepted by the server, with immutable accepted odds and stake. |
| Ticket access code | A high-entropy bearer code for read-only lookup of one accepted ticket; it is not an account credential. |
| Market settlement | The durable grading of market outcomes against a committed fixture result. |
| Bet settlement | The payout/status calculation for an accepted ticket after its selections have market settlements. |
| Suspension | A server-side state in which no new bet can be accepted against a market/round. |

## 4. Shared-Round Clock and Market Availability

The world has one round number shared across the active leagues. Each league has its own season and fixture rows, and all fixtures in a world round share one kickoff time. For betting, all fixtures with the active shared round number form one round offering.

Let $K$ be the earliest scheduled kickoff across all eligible fixtures in the active shared round. Let $C$ be the cutoff:

$$
C = K - 60\text{ seconds}
$$

The API and worker use authoritative server/database time, not a client-provided clock. At or after $C`, the round's open markets become suspended. At each fixture kickoff, that fixture's markets become closed. The bet-acceptance transaction must independently check round, fixture, market, and outcome status plus the cutoff, so delayed queue work or an out-of-date browser cannot accept a late bet.

Round lifecycle:

```text
fixtures scheduled
  -> markets generated and persisted
  -> markets OPEN
  -> cutoff reached: every still-open market in the shared round SUSPENDED
  -> fixture kickoff: that fixture's markets CLOSED
  -> committed match result available
  -> market outcomes SETTLED / VOID under a rules version
  -> accepted tickets whose legs are all final SETTLED
```

Suspension is monotonic for a round: recovery must not reopen markets after the cutoff. Market preparation must happen early enough to make the markets useful; it should be triggered when the coordinator persists the next round schedule rather than being hidden inside an HTTP `GET`. The current `MARKET_PREPARATION_BUFFER_SECONDS` is a runtime tuning value and should not define the one-minute close rule.

The betting desk switches to the next round as soon as its schedule is within the betting window and every scheduled fixture has persisted open market outcomes. Bet placement remains restricted to the current or next world round.

The world coordinator may emit a durable round schedule/status fact. A betting lifecycle worker can consume that fact and create/suspend markets. The API remains a final guard even when workers are delayed. The initial deployment can supervise this worker alongside existing workers; it must not run market math inside the simulation event loop.

## 5. Market Pricing and Versioning

Market generation consumes persisted fixture identity and a versioned snapshot of relevant team ratings/form/history. It returns fair event probabilities, applies an explicit bookmaker margin, and persists each market/outcome. The price record should be auditable by at least:

- fixture, shared round, market type, scope, outcome code;
- model/rules version and pricing timestamp;
- fair probability and published decimal odds;
- source-data/model-input snapshot or a durable reference to it;
- a monotonically increasing price version.

Each odds update appends a price snapshot; it does not rewrite prices accepted on a ticket. A booking slip records the selected outcome identity and the price it displayed when saved. When a booking code is loaded, the API returns both the saved quote and current price/status. The user must see a material price change and choose whether to accept the current quote; loading a code itself never accepts a bet.

Pre-match repricing can eventually run at a modest interval, but the model must separate:

1. fair probability from football data;
2. configured margin/overround;
3. operator exposure and any resulting risk adjustment.

An overround is not realized profit. Exposure-aware changes need accepted-bet data and limits; they should not be simulated from a desired profit target. WebSocket is a delivery mechanism for committed price versions, not the source of price truth. A reconnecting client fetches the latest version from the HTTP API.

No in-play repricer is included now. In-play requires odds updates from persisted/current match state, event-based suspension before material transitions (including goals, penalties, red cards, and halftime), stale-quote rejection, and measured CPU/DB/Redis capacity. Merely changing an odds number every second is not a safe live-betting implementation.

## 6. Straight Multiple Calculation

For decimal leg prices $o_1, o_2, \dots, o_n$, a straight accumulator's combined decimal odds are their product:

$$
O = \prod_{i=1}^{n} o_i
$$

For stake $S$:

$$
\text{Potential return} = S \times O
$$

$$
\text{Potential profit} = (S \times O) - S
$$

Potential return includes return of stake. Use decimal arithmetic, not binary floating-point accumulation; apply the documented currency/odds rounding policy only at defined boundaries. For the initial policy, display/persist combined odds to two decimal places using half-up rounding, then calculate potential return to two decimal places.

Example:

```text
Leg A: 1.79
Leg B: 3.70
Combined: 1.79 × 3.70 = 6.623 -> 6.62
Stake: 100.00
Potential return: 100.00 × 6.62 = 662.00 (includes stake)
Potential profit: 662.00 - 100.00 = 562.00
```

The single-stake straight multiple wins only if every non-void selection wins. A losing selection loses the whole accumulator. Void-leg treatment must be a versioned settlement rule; it is not inferred by silently deleting selections during booking-code load.

The `calculateStraightMultiple` backend function implements the initial decimal arithmetic and rejects duplicate fixture IDs. Its input must come from currently persisted/validated market outcomes, not prices trusted from the client.

### 6.1 Combinator and system bets

A straight accumulator is not a system/combinator bet. A full-cover system creates multiple separate lines from the chosen selections. For $n$ selections and folds from $k$ through $n$, the number of lines is:

$$
L = \sum_{j=k}^{n} \binom{n}{j}
$$

For example, a four-selection Yankee is six doubles, four trebles, and one fourfold: $\binom{4}{2}+\binom{4}{3}+\binom{4}{4}=11$ lines. If the stake is $s$ per line, total stake is $11s$; if the UI takes a total stake, per-line stake is total stake divided across those lines under a documented rounding rule. Each line settles independently. Trixie, Yankee, Patent, Lucky 15, and other systems should be separate bet types with explicit line enumeration, per-line stake, and return tests. Do not label a straight accumulator a combinator.

System bets are deferred until straight multiple behavior is stable.

### 6.2 Same-fixture correlation / Bet Builder

Multiplying individual prices for two outcomes in the same match assumes independence. Football selections are often correlated or logically incompatible: Home Win and Home -0.5 overlap; Over 2.5 and Correct Score 3-1 are related; Home Win and Away Win conflict. Standard accumulator products therefore must not accept multiple selections from one fixture in this phase.

A future Bet Builder needs a declared set of compatible selections and a joint event probability $P(A \cap B \cap \dots)$ from the match model or an explicitly calibrated joint pricing model. The fair joint price is based on that joint probability, then margin/risk policy is applied. It cannot be obtained safely by multiplying standalone odds. Betfair's public help material distinguishes Bet Builder from ordinary multiples, notes that not all selections are eligible, and describes related contingencies as outcomes whose relationship affects price.

## 7. Persistence Model

The existing database already has leagues, seasons, fixtures, `markets`, `market_outcomes`, and `odds_snapshots`. `markets.fixture_id` makes market instances fixture-specific. Keep and extend these rather than embedding market state in the simulation.

Recommended durable records:

- **Market/outcome:** one market per fixture/type/scope and one row per outcome; enforce uniqueness where the product contract permits it.
- **Odds snapshot:** append-only price history with version/model metadata. A change is a new snapshot.
- **Booking slip:** unique public code, created-at, optional expiry/version metadata. It has no user, stake, wallet debit, or bet status.
- **Booking selections:** normalized rows referencing fixture, market, outcome, and displayed price version/odds. Enforce one selection per fixture for the initial straight-multiple product.
- **Bet:** created only by authenticated acceptance. It has a distinct bet-slip ID, user, stake, total odds, potential return, idempotency key, placed time, and status.
- **Bet selections:** immutable accepted fixture/market/outcome/price/version rows. They survive later market repricing.
- **Market result/settlement:** one durable result per market outcome or market selection, linked to fixture and committed result identity/hash, with status and settlement-rules version.
- **Bet settlement:** a distinct idempotent record per accepted bet, created after all its selections have final market results.

The current `settlements` table is bet-centric and cannot substitute for durable per-market results. The current `bets` table is user-bound and is not a booking slip. Avoid overloading either table with booking data.

Booking codes should be generated by the server with a cryptographically secure random source, normalized for case, unique-indexed, and rate-limited for creation and lookup. The code is deliberately shareable and therefore is not an authentication credential. Return only selection data that a public market user is allowed to view. Apply retention/expiry after product agreement; a loaded unavailable slip must explain why its selections cannot currently be used.

## 8. API Boundaries

Initial public API surface:

```text
GET  /api/betting/rounds/current
GET  /api/betting/markets?round=...&leagueId=...
GET  /api/betting/fixtures/:fixtureId/statistics
GET  /api/fixtures/:fixtureId/markets          (read-only; no creation side effect)
POST /api/betting/bookings                     (save an unplaced slip; no auth)
GET  /api/betting/bookings/:code               (load a shareable slip; no auth)
```

Booking create input contains selection identities, not trusted price, payout, round, or status values. The service resolves each leg in PostgreSQL, verifies fixture/round membership, market/outcome existence and current availability, prohibits duplicate fixtures, snapshots quote identity, and persists the booking transactionally. Booking load resolves those same IDs against current records and returns line-by-line status plus `canUse`; one unavailable leg makes `canUse=false` until the user removes/replaces it. It must not silently delete or reprice an unavailable line.

Later authenticated surface:

```text
POST /api/bets                 (accept funded bet from server-validated selections)
GET  /api/bets/:betSlipId      (private accepted ticket and status)
GET  /api/bets                 (private user's ticket history)
```

Bet placement requires authentication, wallet balance, server-derived price, acceptance-time cutoff/status check, transactional debit/ledger/bet rows, and an idempotency key. It is deliberately not part of the booking-code APIs. The existing single-selection `/api/bets` endpoint is a legacy capability and must not be confused with the future multiple API.

All `GET` market endpoints are read-only. A missing market is generated by a worker/coordinator action, not by the request. The existing market API's dynamic creation fallback must be removed or isolated behind an explicit idempotent command before the sportsbook becomes a dependable consumer.

## 9. Market Outcome and Bet Settlement

Settlement has two separate facts:

1. **Market settlement:** after a final fixture result is committed, a settlement worker evaluates the result against each market's rules and records the outcome, fixture result hash/ID, settlement rules version, and settlement time. This operation is idempotent and independent of whether a user bet that market.
2. **Bet settlement:** a separate ticket-level step reads the accepted bet's immutable selections and their market settlement records. It waits until all required selections are final, computes the return using stored accepted odds and the versioned void/push policy, updates the bet, and inserts the unique payout/settlement ledger transaction atomically.

No ticket should derive a result directly from mutable scores after the market result was committed. No fixture completion should credit a wallet directly from the simulation process.

Open policy items before bet settlement: postponed/cancelled/abandoned match treatment; missing corner/card/player statistics; score correction after full time; void selection treatment in an accumulator; maximum stake/payout; price-change acceptance; bet cancellation. These must be explicit, versioned, tested rules. Do not substitute fabricated statistics to settle a wager.

## 10. Statistics and Probability Context

The first statistics surface should use SimSoccer's own persisted virtual-world history, not an unrelated live-football feed. Useful first facts include last five head-to-head meetings (when available), each team's last five completed fixtures, goals for/against, and a clear sample count. If fewer than five games exist, display the available count rather than inventing history.

Stats APIs are read-only. A historical summary may inform pre-match fair probabilities, but it is not a guaranteed prediction and does not replace the match result. Store the feature/model version used to price a market so probabilities and odds can be audited.

## 11. Frontend: Separate Betting Space

Add a dedicated `/betting` route; do not turn the match centre into a sportsbook or make the admin app part of this flow. Use a compact fixture-market layout inspired by the supplied screenshots, adapted to the current SimSoccer typography and palette.

Desktop structure:

```text
┌─────────────────────────────────────────────────────────────────────┐
│ SimSoccer brand                 Matches | My Bets | Sign in          │
├──────────────┬──────────────────────────────────┬───────────────────┤
│ Competitions │ Round fixtures and quick markets │ Slip / code load  │
│ and round    │ 1X2 · DC · O/U · more markets    │ selections        │
│ navigation   │                                  │ combined odds     │
│              │ expanded fixture markets         │ booking code      │
└──────────────┴──────────────────────────────────┴───────────────────┘
```

Mobile uses a single-column fixture list and an accessible, persistent slip entry point; the full slip and booking-code lookup open in a compact sheet/panel rather than squeezing desktop columns. The primary market action is selecting an outcome. A per-fixture expand action reveals additional markets (goal totals, handicap only when supported, half-time result, correct score, and later markets). Do not display a market that the backend cannot price and settle.

The slip needs selection rows, remove actions, combined odds, and (later) stake/potential return. Before account/funding is implemented, it can save/load a booking code and show that actual placement requires the future account flow. It must never simulate successful bet placement.

A loaded booking slip shows unavailable/suspended selections inline and disables re-saving/acceptance until corrected. Price changes are visible; no silent price update. The accepted-ticket/outcome view belongs under “My Bets” later and uses a bet slip ID, never the booking code.

## 12. Real-Time Delivery

For pre-match markets, HTTP returns the current persisted market/price version. WebSocket broadcasts a compact `MARKET_PRICE_CHANGED` or `MARKET_SUSPENDED` event only after database commit. Messages include fixture/market/outcome identifiers, version, price/status, and server timestamp. On reconnect, clients refetch the API and discard older versions.

The existing `/ws` is for match events. Either add a typed market subscription to it or a separately versioned betting channel; keep market events namespaced and avoid opening one socket per outcome. The client cannot use WebSocket state as authority to submit a future bet.

## 13. Operational and Security Requirements

- Persist all user-visible booking codes and selection identities in PostgreSQL; Redis jobs are recoverable hints, not booking truth.
- Use database uniqueness and idempotency constraints to make market preparation, suspension, result creation, and ticket settlement retry-safe.
- Rate-limit anonymous booking creation and code lookup; use opaque codes with enough entropy to resist enumeration.
- Validate payload size/count/type and reject unknown or duplicate legs.
- Use database transactions for multi-row booking writes and, later, wallet debit plus accepted ticket creation.
- Do not trust browser time, displayed odds, stake totals, combined odds, or payout values.
- Log stable IDs and status transitions, never authentication tokens or database credentials.
- Keep simulation and pricing compute bounded; do not recalculate every market on every WebSocket message.
- Maintain explicit ownership and migration procedure for schema changes. Never silently reset the world database to add betting tables.

## 14. Implementation Phases

### Phase A: market foundation and booking (current)

1. Fix event probability preservation and establish straight-multiple decimal calculation tests.
2. Make market reads read-only; markets are prepared/persisted by a worker/coordinator when the round is scheduled.
3. Create one shared-round cutoff and monotonic suspension rule; enforce current market status when loading bookings.
4. Add normalized, persistent booking slips/selections and public create/load APIs.
5. Add the separate responsive `/betting` UI with league/round navigation, quick markets, expanded markets, slip controls, booking-code sharing/loading, and unavailable-leg states.
6. Add generated-market and booking API/service tests with a disposable database where appropriate.

### Phase B: pricing evolution and statistics

1. Persist versioned price/model snapshots and use round history, team ratings/form, and head-to-head facts.
2. Add model-calibration reports and compare predicted probabilities with simulated outcomes over many matches.
3. Add bounded pre-match repricing using explicit, replayable inputs. Exposure adjustment waits until accepted bets exist.
4. Publish committed price/status changes to WebSocket subscribers and test reconnect/version behavior.

### Phase C: authenticated funded play-money placement and ticket access (implemented)

1. Require a completed signed-in account and sufficient play-money wallet balance.
2. Accept one straight multiple atomically, validate prices/cutoffs in the DB transaction, debit once, and store all accepted legs and immutable odds.
3. Provide owner-scoped history/detail endpoints and a `/bets` screen with Open and Settled tabs.
4. Issue a separate code for single-ticket public lookup; store only its hash, rate-limit lookup, and keep account, wallet, and other-ticket data out of the response.

### Phase D: durable market and ticket settlement

1. Create market outcome settlement records after committed fixture results.
2. Run settlement independently and idempotently from ticket settlement.
3. Implement explicit void/missing-statistics/result-correction policy and audit trail.
4. Test retries, crash/restart, partial round completion, and payout exactly-once behavior.

### Phase E: true in-play betting (not currently resourced)

1. Measure simulation worker, database, Redis, and WebSocket headroom under all three leagues.
2. Define which events suspend which markets and safe resume behavior.
3. Price from current persisted match state/event sequence, use short quote validity, and reject stale versions.
4. Load-test event bursts, goal suspensions, queue delay, process restart, and high connection counts before release.

## 15. Acceptance Criteria for Phase A

- Match simulation output is unchanged by any betting operation.
- Upcoming markets exist before cutoff without requiring a `GET` side effect.
- The shared round suspends 60 seconds before its shared kickoff.
- The API refuses to treat any client clock or stale browser as evidence that a market is open.
- Multiple selections across the three leagues are allowed only when they share the active round; duplicate fixture selections are rejected in this phase.
- Straight-multiple prices use decimal multiplication and exact rounding; total return includes stake and profit is separately shown.
- Booking codes are not bets, can be shared/loaded without authentication, and do not lock prices or funds.
- Loading a booking after a cutoff shows the unavailable selection and makes the slip unusable without silently deleting any leg.
- No betting API or UI path claims that an actual bet was placed; only the later authenticated API may return a bet slip ID.
- Desktop and mobile layouts remain usable with loading, empty, offline, unavailable, and price-changed states.

## 16. Research Notes

Public sportsbook material is useful for observable product rules, not private source code or a universal legal standard:

- [Betfair: Bet Types Explained](https://support.betfair.com/app/answers/detail/7-bet-types-explained/) describes a double/treble/accumulator as requiring all included selections to succeed, distinguishes full-cover systems such as Trixie and Yankee, and explains that related contingencies can prevent some multiple combinations.
- [Betfair: Bet Builder](https://support.betfair.com/app/answers/detail/a_id/6653) describes a within-match accumulator as a dedicated product, notes that not all selections are eligible or compatible, and gives a separate rule for a void leg.
- [Betfair: How to Place a Bet](https://support.betfair.com/app/answers/detail/a_id/10/) separates singles, multiples, accumulators, and Bet Builder flows in its user-facing process.

These sources do not specify SimSoccer's margin, void, cutoff, exposure, identity, or settlement rules. Those remain explicit SimSoccer decisions in this document. This system is currently play-money development; this document is not advice on licensing or real-money operation.
