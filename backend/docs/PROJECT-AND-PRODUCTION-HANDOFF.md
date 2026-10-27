# SimSoccer Project and Production Handoff

- **Snapshot date:** 2026-10-26
- **Repository:** `SimCore-Labs/simsoccer`
- **Backend release deployed:** `cf04479`
- **EC2 checkout revision checked:** `cf04479`

This is an operational snapshot of the project and its production environment.
It supplements [DEPLOYMENT-HANDOFF.md](./DEPLOYMENT-HANDOFF.md), which contains
the more detailed custom-auth configuration, migration, and rollout procedure.
Production health can change after this snapshot; check the live endpoints
before acting.

## Replacement deployment — 2026-10-26

This is the current deployment record. The 2026-10-07 machine and world details
below are historical; the replacement uses a new, clean application database.

### Host and access

| Property | Current value |
|---|---|
| EC2 instance | `i-0a383b514b86bf522` |
| Region / OS | `eu-north-1` / Ubuntu 24.04 |
| Instance type | `c7i-flex.large` |
| Elastic IP | `13.63.182.101` |
| Root volume | 30 GiB encrypted gp3 |
| Project checkout | `/home/ubuntu/simsoccer`, revision `cf04479` |
| SSH key pair | `simsoccer-production-20261026` |

The SSH private key is kept in an ignored local file and must not be copied
into Git or this document. Inbound SSH is restricted to the deployment
workstation's `/32`; authorize another fixed operator IP in the EC2 security
group before connecting from a different network. Do not open SSH to the
internet.

### Database and initial world

- The previous `muizdev` database was not reset or modified. A completed RDS
  snapshot named `simsoccer-pre-redeploy-20261026` preserves the pre-deployment
  state.
- The new application database is `simsoccer_prod` on the existing RDS
  instance. It contains 41 public tables and all 15 current migrations.
- The initial `Season 1` seed created 3 leagues, 3 seasons, 60 teams, and 1,140
  scheduled fixtures. It also created the `demo@simsoccer.com` admin-role
  account and its 3,000-credit virtual wallet.
- No world reset or production integration test was run. The migration and
  seed safety overrides remain disabled in the backend `.env`; the seed used
  a one-command explicit confirmation after verifying the target database.
- The RDS security group still allows public PostgreSQL ingress. Do not narrow
  it until other consumers of the shared instance have been identified.

### Services and verification

All three services are built and run under PM2, with the process list saved
and the `pm2-ubuntu` systemd unit enabled and active:

| PM2 process | Port | Responsibility |
|---|---:|---|
| `simsoccer-runtime` | 8080 | World API, simulation, coordinator, and workers |
| `simsoccer-accounts` | 8090 | Accounts and authentication API |
| `simsoccer-settlement` | 8091 | Settlement API and worker |

Backend, Accounts API, and Settlement API TypeScript builds passed on EC2.
Focused unit tests passed (6 backend tests, ticket-access checks, 11 Accounts
API tests, and settlement rules). The database-backed comprehensive backend
test was intentionally not run against production.

PostgreSQL and Redis readiness passed for each service, and the settlement
worker acquired leadership and completed a successful scan. Nginx routes
authentication and account requests to port 8090, settlement requests to 8091,
world requests and `/ws` to port 8080. Let's Encrypt issued a certificate for
`simapi.muizdev.xyz` on 2026-10-26; Nginx redirects HTTP to HTTPS. Public
backend, Accounts API, settlement readiness, world status, and public-only
JWKS endpoints returned HTTP 200 over HTTPS. Certbot renewal dry-run should be
completed to verify automated renewal end to end.

The generated Accounts API signing key and authentication peppers are stored
only in the protected, ignored environment files on the host and local
workstation. No admin credential has been bootstrapped yet; perform
`npm run admin:bootstrap` interactively on the host and do not share the PIN
through chat. Email delivery has not yet been independently tested.
The replacement Resend API key was uploaded to the protected Accounts API
environment on 2026-10-27, accepted by Resend, and its configured sender domain
reported verified. No verification email was sent as part of this check.

Cluster-aware Solana payment support was built and verified on EC2 on
2026-10-27. The live backend environment remains `SOLANA_CLUSTER=devnet` with
payments enabled; mainnet was not activated because SimSoccer's own protected
backend environment still points to the devnet RPC and has no dedicated
mainnet treasury configured. Mainnet wallet checkout source is in the host
checkout and its production build passed; Vercel has not been redeployed from
this working-tree change. The cluster-aware backend supports Solana's shared
public mainnet RPC (verified from EC2), but that endpoint is rate-limited and
has no provider SLA; configure it only once the dedicated treasury and
front-end rollout are ready. Keep the product on devnet until the public RPC
and treasury are configured in SimSoccer's protected environment, the reviewed
frontend is deployed, and the legal and operational readiness gates in
[SOLANA-CREDITS-PAYMENTS.md](./SOLANA-CREDITS-PAYMENTS.md) are satisfied.
Withdrawals/redemption are not implemented.

### DNS and HTTPS

The frontend remains on Vercel at `https://simsoccer.vercel.app`. The API A
record is now:

```text
simapi.muizdev.xyz  A  13.63.182.101
```

At cutover the hostname briefly resolved to the former address `13.61.146.106`.
After DNS reached the Elastic IP, Certbot issued the certificate and Nginx
enabled the HTTPS redirect. The frontend was not redeployed or changed.

## At a glance

SimSoccer runs a persistent, play-money football world. The backend owns the
fixtures, match state, results, league tables, betting markets, and settlement
work. The browser displays this data and provides account and betting screens;
it does not run or control the simulation.

The project has four main applications:

| Application | Location | Responsibility |
|---|---|---|
| Frontend | `frontend/` | Next.js website: live matches, fixtures, results, tables, betting UI, My bets ticket history and lookup, account/auth screens, and administration UI |
| World backend | `backend/` | Express API, PostgreSQL/Drizzle data, world coordinator, match simulation and background workers, betting and settlement |
| Accounts API | `accounts-api/` | Express API for first-party registration, verification, sessions, profile, and account endpoints |
| Settlement API | `settlement-api/` | Independent settlement API and worker sharing the PostgreSQL database |

The website is normally deployed automatically by Vercel from `main`.
Backend services are deployed manually to EC2. A frontend commit does not by
itself update the EC2 checkout, and an EC2 pull does not deploy the website.

## Previous production machine (snapshot 2026-10-07)

The production backend runs on an AWS EC2 instance:

| Property | Observed value |
|---|---|
| Instance | `i-071f530b475f93dd3` (`simsoccer-backend`) |
| Region | `eu-north-1` |
| Operating system | Ubuntu |
| Instance type | `t3.micro` (2 vCPU, about 1 GiB RAM) |
| Public IPv4 at the time of the snapshot | `13.61.146.106` |
| Public DNS at the time of the snapshot | `ec2-13-61-146-106.eu-north-1.compute.amazonaws.com` |
| Private IPv4 | `172.31.16.84` |
| SSH account | `ubuntu` |
| Project checkout | `/home/ubuntu/simsoccer` |

The public address is auto-assigned and may change. The instance has no
Elastic IP recorded in the earlier EC2 console snapshot. Reconfirm the current
address and instance identity in AWS before using an old address.

At the live resource check for this snapshot, the root filesystem showed
approximately 6.7 GiB total with 2.5 GiB free. Linux reported about 908 MiB
memory total, with about 208 MiB available. These are point-in-time figures,
not capacity guarantees. This is a small host; large local builds can compete
with the always-running world service for memory.

### Historical SSH access

The authorized SSH key is stored locally at `C:\simsoccer\wesheild.pem`.
The key itself must remain private, excluded from Git, and outside this
document. Do not send it to another developer. A developer without authorized
access must obtain their own key/access through the owner.

From PowerShell:

```powershell
ssh -i C:\simsoccer\wesheild.pem `
  -o IdentitiesOnly=yes `
  -o BatchMode=yes `
  -o StrictHostKeyChecking=yes `
  ubuntu@13.61.146.106
```

Use the current AWS-confirmed IP or DNS name if it changes. Host-key checking
is intentionally enabled. If SSH reports a host-key change, stop and verify
the EC2 host identity through AWS/out-of-band information; do not bypass the
check or accept an unexplained new key.

The remote deployment tools used for safe, read-only checks include:

```bash
pm2 status
pm2 describe simsoccer-runtime
pm2 describe simsoccer-accounts
sudo nginx -t
curl -sS http://127.0.0.1:8080/api/health
curl -sS http://127.0.0.1:8080/api/world/status
curl -sS http://127.0.0.1:8090/api/health/live
curl -sS http://127.0.0.1:8090/api/health/ready
```

Do not print `.env` files, process environments, tokens, cookies, email codes,
database URLs, Redis URLs, or signing keys into terminals that may be logged
or copied. Use filtered checks that report only whether a variable is set.

## Services and request routing

The backend applications are supervised by PM2:

| PM2 process | Working directory / entry point | Port | Responsibility |
|---|---|---:|---|
| `simsoccer-runtime` | `/home/ubuntu/simsoccer/backend`, `dist/start.js` | `8080` | World API, persistent simulation runtime, coordinator and backend workers, betting API |
| `simsoccer-accounts` | `/home/ubuntu/simsoccer/accounts-api`, `dist/server.js` | `8090` | Account, verification, session, and custom-auth API |
| `simsoccer-settlement` | `/home/ubuntu/simsoccer/settlement-api`, `dist/server.js` | `8091` | Settlement API and independent worker |

Nginx terminates the public web/API traffic. Its configuration must route
`/api/auth/` and `/api/account/` to port `8090`, and the world API routes to
port `8080`. Keep the account routes ahead of the general `/api/` world route
so they are not swallowed by it. The Nginx configuration syntax check passed
in the recorded production session.

The public API hostname is `https://simapi.muizdev.xyz`. The signing public
keys are published at
`https://simapi.muizdev.xyz/api/auth/.well-known/jwks.json`; this endpoint
contains public verification keys, not the private signer.

PostgreSQL is the durable store for world and account data. Redis supports
queues, coordination, and distributed auth rate limits. Resend is configured
for account verification and recovery email. The exact database, Redis, and
email-provider values are secrets and are deliberately not recorded here.

## The persistent world

The world is designed to run independently of the website:

1. PostgreSQL stores seasons, league rounds, fixtures, match state/events,
   markets, standings, bets, and settlement records.
2. The backend coordinator schedules world rounds and match starts.
3. Background workers advance match events and process post-match work.
4. Redis/BullMQ coordinates work; it is not the permanent source of world
   state.
5. The frontend reads the world API and live transport. Closing a browser must
   not stop or reset the world.

The product is play-money only. The world generates its own football schedule
and match outcomes; betting consumes those results and must not influence
simulation. Real-money deposits, withdrawals, and payouts are outside the
current scope.

### World state observed on EC2

At the start of the investigation, `/api/world/status` showed Season 2, Round
17 of 38, with 30 live, 480 completed, and 630 scheduled fixtures across
Premier League, La Liga, and Serie A. After the Accounts API update was
activated, the world remained `RUNNING` and had advanced to Round 18, with 30
live, 510 completed, and 600 scheduled fixtures total. This confirms the
simulation continued while the Accounts API was built and restarted.

- PostgreSQL, Redis, and migration checks were reported as healthy by the
  world backend.
- The returned status reported `isCoordinatorLeader: false` and no coordinator
  node ID, despite a running status and heartbeat. This is included as an
  observation, not proof that the coordinator lease is healthy.

This is a timestamped snapshot, not a promise that the same round or fixture
counts remain current. Check `/api/world/status` before any operation that
could pause or modify the world. Never run a reset or destructive seed command
as a deployment shortcut.

## Custom accounts and authentication delivered

Supabase Auth was replaced in the repository by a first-party Accounts API.
The deployed design includes:

- Email/password registration and eight-digit email verification.
- Password sign-in followed by a one-time email code, plus a separate
  passwordless email-code flow.
- Password recovery and password change.
- Argon2id password hashing.
- RS256 access tokens, a public JWKS endpoint, and world-backend token
  verification.
- Rotating opaque refresh sessions in secure, HTTP-only cookies.
- Session revocation, email/IP/session rate limits, and account profile
  completion.
- Random first-party device-recognition cookies and keyed hashes for stored
  device, IP, and user-agent signals. This is not invasive canvas/audio
  fingerprinting.
- A database migration adding verification, challenge, session, and device
  records while preserving existing users and wallets.

The migration `0007_first_party_auth.sql` was previously applied to production
after a database backup was created and checked. The prior production rollout
record says the Accounts API tests (8/8), world tests (13/13), and both API
builds passed on EC2. Do not infer that these tests were run again merely
because the machine is currently online.

For the follow-up Accounts API reliability update, the 8 Accounts API tests
passed again on EC2 and the updated API compiled successfully. The first
compile attempt was killed (exit 137) while the old Accounts API was still
running; the retry stopped only that API, built into a separate output
directory, then activated the result. The world runtime stayed online.

Existing users' legacy IDs and wallet data are retained. Old identity-provider
passwords are not imported. An unverified registration may leave an
unverified account record if email delivery or the browser flow fails;
retries should reuse the same email rather than create a different account.
Do not test signup against a real user's email without authorization.

Email codes are not phishing-resistant MFA. Control of the email account can
defeat the email-code step; do not market the flow as NIST AAL2 or equivalent.

## Frontend work recorded

The repository's `main` includes the recent frontend work:

- Goal timelines are expandable from the match row.
- Timeline events align with the team columns, group the minute and ball icon
  closely, and omit per-goal separator rules.
- The live goal ticker includes fixture matchup context alongside goal time
  and scoring team.
- The signup screen no longer repeats “Create your account.” below the
  identical heading.
- Authentication failures use simpler user-facing copy instead of developer
  configuration details.
- Profile completion uses a consistent completion label and an inline
  spinner while submitting.
- Account endpoints can be routed through the same-origin Next.js auth proxy.
- A GET request to the refresh endpoint is now explicitly rejected with
  `405`; refresh is a POST-only session operation and should not be opened as
  a page in a browser.

The frontend auth-copy commit `e7cf023` is followed by the same-origin account
proxy and betting profile-check changes in `d7a308d`. Vercel is configured for
automatic frontend deployment from `main`; the deployment was verified by
checking the live refresh and account proxy routes after the update.

## Production verification and remaining limits

Initial checks found the issue below. After the fix was deployed, production
was rechecked:

- PM2 showed both `simsoccer-runtime` and `simsoccer-accounts` as `online`.
- World API `/api/health` returned `status: ok`.
- World API `/api/health/ready` returned `ready`; `/api/world/status` remained
  `RUNNING`.
- `sudo nginx -t` passed.
- The Accounts API `/api/health/live` returned `status: live`.
- Accounts API `/api/health/ready` returned
  `{"status":"ready","dependencies":{"postgres":true,"redis":true}}` on five
  consecutive public checks after deployment.
- A correctly formatted sign-in request using a nonexistent test address
  returned `401`, as expected for invalid credentials. No real account was
  used. This does not validate email delivery, signup completion, or profile
  completion.
- `GET /api/auth/refresh` returned `405` from the website and API; `POST
  /api/auth/refresh` without a refresh cookie returned `401`. Refresh is a
  session operation, not a browser page.
- The same-origin account profile endpoint returned the expected `401` when
  called without a session.
- The public betting markets endpoint returned `200` with fixture market
  data.

**Resolved production reliability defect:** Accounts API readiness had
repeatedly returned `not_ready` while the world backend was ready. Account
sign-in requests also returned `500`; the old logs recorded only a generic
`Error`, not enough to prove the immediate failure cause.

One concrete reliability difference was found in source: the Accounts API's
shared Redis client used `retryStrategy: () => null`. Once that client
encountered a connection failure, it stopped reconnecting, while the world
runtime's BullMQ Redis connection uses the normal reconnecting client policy.
This can leave the account process online but unable to use Redis-backed
rate limits until it is restarted. Commit `d7a308d` now retries Redis
connections with a capped delay, logs sanitized Redis connection metadata,
exposes separate PostgreSQL/Redis readiness booleans, and returns a
service-unavailable response when Redis is disconnected. Account profile
lookups in the betting UI now use the same-origin auth proxy instead of
requiring a separate browser-side Accounts API URL. The new account code was
built and activated on EC2 without stopping the world runtime.

Readiness and safe unauthenticated route checks pass after deployment. A PM2
`online` state by itself is still not a dependency health check. Signup email
delivery and a real account's end-to-end sign-in/profile flow have not been
tested.

Previously observed browser requests produced 500s on sign-in/signup. The
server logs from before the fix did not reveal the underlying exception for
those requests. Malformed JSON requests produced parser errors, but that is
separate from a correctly formatted request. A valid-format synthetic sign-in
after the fix returned the expected 401; the actual user account flow remains
unverified.

## Source and deployed revision relationship

The My bets and secure ticket-lookup release was pushed to `main` and deployed
to EC2 at `b8bcf7e`. The website deploys from `main` through Vercel; backend
services deploy separately to EC2. The pre-release EC2 checkout was `279f55f`,
which includes the Accounts API recovery fix from `d7a308d`.

### Solana devnet payment prototype release — 2026-10-06

- Backend release `e58c127` was fast-forwarded onto EC2 from `origin/main`.
- All three PM2 services (`simsoccer-runtime`, `simsoccer-accounts`, and
  `simsoccer-settlement`) were stopped before the release and restarted after
  the database migration and backend build. PM2 state was saved.
- Before migration 0013, a PostgreSQL custom-format backup was created at
  `/home/ubuntu/simsoccer-backups/simsoccer-solana-pre-migration-20261006T130508Z.dump`.
  `pg_restore --list` verified the archive (72,945,202 bytes; SHA-256
  `742c08ee636a11c75a5393dff80f8343ae50179c80decce47f119ee48c200a76`).
- Migration `0013_solana_credit_payments` was applied and verified. The
  production Drizzle migration journal now has 14 entries, and both payment
  tables exist. No world reset, truncation, or test payment was performed.
- The backend installed the committed lockfile with npm 11.21.0; npm 10's
  `npm ci` rejected the lockfile as out of sync. The backend production build
  then passed.
- The protected backend `.env` was updated without exposing its contents.
  `MIGRATE_BEFORE_BUILD=false`; `ALLOW_PRODUCTION_MIGRATIONS=true` is retained
  because the runtime supervisor checks this permission when it runs
  migrations at startup. Solana payments are enabled on `devnet`; the treasury
  address was copied from the validated repository example without exposing
  it in logs or documentation. Mainnet payments are not supported.
- All three PM2 processes are `online`. Backend liveness/readiness passed;
  PostgreSQL, Redis, and migrations report healthy. Accounts API and
  settlement readiness passed, with a successful settlement scan and no
  consecutive errors. The world reports `RUNNING` at Season 2 Round 35.
- `sudo nginx -t` passed. Public website routes `/account` and
  `/account/credits`, and public API health/readiness endpoints, returned
  HTTP 200. The exact Vercel deployment revision was not independently
  confirmed.

### Checkout and authentication UX update — 2026-10-06

- Release `28e97cf` was pushed to `main` and fast-forwarded on EC2. No database
  migration was needed.
- All three PM2 services were stopped before the pull/build and restarted
  afterward. Backend build passed; PM2 state was saved.
- Devnet payment settings were enabled in the protected backend `.env` using
  the already-validated `.env.example` values. The runtime reports payments
  enabled, cluster `devnet`, and a configured treasury; the address is not
  recorded here.
- World and Accounts API readiness passed, Nginx configuration passed, and all
  three PM2 services are online. The world reports `RUNNING`.
- The credit checkout now uses a concise package-first flow, and the auth
  screen no longer renders its extra header. Vercel deployment revision still
  needs independent confirmation.

### Centered checkout, custom top-ups, and wallet detection — 2026-10-06

- Backend release `599c7a8` was fast-forwarded onto EC2 after all three PM2
  services were stopped. The backend build passed; no database migration was
  needed. All three services restarted and PM2 state was saved.
- The checkout supports preset credit packages and custom top-ups from 1,000
  to 100,000 credits in steps of 10. The backend validates the amount and
  calculates the matching USD/SOL quote using the existing package rate.
- The checkout centers the package choices and Continue button, and discovers
  installed devnet-compatible Wallet Standard wallets with legacy injected
  wallet fallbacks.
- Production reports payments enabled on devnet with a configured treasury.
  The address is not recorded here. World and Accounts API readiness passed;
  all three PM2 services are online; world status is `RUNNING`; `sudo nginx
  -t` passed.
- Frontend build and targeted backend payment tests passed locally. The
  frontend deploys from `main` through Vercel; its exact deployed revision
  could not be independently confirmed.

### Credits checkout dialogs and wallet history — 2026-10-07

- Release `1ff5d0b` was fast-forwarded onto the EC2 checkout from `599c7a8`.
  The deployed change adds the authenticated wallet-address lookup and payment
  metadata to wallet transaction history. The checkout dialogs and related
  account UI deploy separately through Vercel.
- The complete commit range contained no database migration files or schema
  changes. No database migration was needed; the backend startup migration
  check passed and world readiness reports PostgreSQL, Redis, and migrations
  healthy.
- The frontend production build, backend TypeScript build, and targeted
  `solana-payments.test.ts` passed locally. The built backend output was
  transferred to EC2; the prior `backend/dist` was retained as
  `backend/dist.previous-1ff5d0b` for rollback.
- Only `simsoccer-runtime` was stopped and restarted. Accounts and settlement
  remained online, and PM2 state was saved. All three PM2 processes now report
  `online`; world health returned `ok`, Accounts API readiness returned
  `ready`, and Nginx configuration validation passed.
- The world reports `RUNNING` at Season 3 Round 8 with PostgreSQL and Redis
  healthy. The new wallet lookup route returned `401 Unauthorized` without
  credentials, confirming it is registered and remains protected.
- The public Vercel `/account/credits` page returned HTTP 200, but its deployed
  commit was not independently confirmed. No reset, production test payment,
  or data-destructive operation was performed.

## My bets release verification — 2026-10-05

- Release commit: `b8bcf7e` (`Add My bets ticket history and lookup`).
- Database migration `0008_glamorous_mauler` is recorded. The `bets` table has
  the nullable unique `public_ticket_code_hash` column. Existing tickets were
  not assigned access codes; they remain available to their owners in signed-in
  history, while signed-out lookup applies to new accepted tickets.
- Before migration, a PostgreSQL custom-format backup was created and checked
  with `pg_restore --list`. It is stored on EC2 at
  `/home/ubuntu/simsoccer-backups/simsoccer-2026-10-05T08-05-48-053Z.dump`
  (50,252,880 bytes; SHA-256
  `98eb9b84587fbadc8c839d16295534176109363199e499c64f111cbcead93eb6`).
- `simsoccer-runtime` and `simsoccer-accounts` were restarted and both reported
  `online`. World health returned `ok`, Accounts API readiness returned
  `ready` with PostgreSQL and Redis healthy, and the world reported `RUNNING`
  at Season 2 Round 18.
- `sudo nginx -t` passed. Public betting markets returned `200`; malformed or
  unknown public ticket codes returned the uniform `404 TICKET_NOT_FOUND`
  response. The Vercel `/bets` page returned `200` and served the ticket lookup
  interface.
- No environment variables changed for this feature; the protected EC2 `.env`
  was not replaced. No world reset, database truncation, or production test bet
  was performed. A real ticket code was not used for a public lookup smoke
  test, to avoid exposing a user's bearer code.

The website and EC2 APIs deploy separately. For later backend deployments,
compare changed paths, review database migration requirements, take and verify
a backup when needed, and follow the coordinated procedure in
[DEPLOYMENT-HANDOFF.md](./DEPLOYMENT-HANDOFF.md).

The existing deployment handoff contains older planning and validation
snapshots. Use this document's dated observations for the state recorded
above, and recheck production before making operational decisions.

## Operator guardrails

- Do not commit or share `wesheild.pem`, `.env` files, database credentials,
  Redis credentials, Resend secrets, private signing keys, session tokens, or
  email codes.
- Do not stop the EC2 instance or stop `simsoccer-runtime` to troubleshoot the
  website. Stopping the runtime pauses the live simulation.
- If only the Accounts API needs a restart and an authorized operator approves
  it, restart only `simsoccer-accounts`, then verify its readiness and the
  world API status. A restart is not a substitute for finding the cause of a
  recurring readiness failure.
- Do not rerun migrations, reset the world, truncate data, or seed production
  without an explicit reviewed procedure and verified backup.
- Never run automated test suites against production user/world data. Use an
  isolated database, Redis instance, and test inbox.
- After any deployment, record the Git SHA, migration result, PM2 state,
  health/readiness results, Nginx validation, and world status. Do not record
  secrets or personal account data.
