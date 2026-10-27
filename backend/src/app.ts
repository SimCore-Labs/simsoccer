import express, { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';
import { db } from './db/index';
import { leagues, seasons, teams, players, teamRatings, fixtures, matches, matchEvents, matchStatistics, markets, marketOutcomes, wallets, walletTransactions, bets, betSelections, settlements, standings, users, authSessions, authDevices, authChallenges, adminCredentials, adminSessions, adminAuditLog, solanaPaymentOrders, solanaPaymentAttempts } from './db/schema/index';
import { authenticateJwt, requireLocalAccount, requireRole, AuthenticatedRequest } from './auth/jwt';
import { placePlayMoneyBet } from './betting/bet-service';
import { createBookingSlip, listBettingMarkets, loadBookingSlip } from './betting/market-service';
import { getFixtureStatistics } from './betting/statistics-service';
import { hashTicketAccessCode, isTicketAccessCode } from './betting/ticket-access';
import { MatchEngine } from './simulation/match-engine';
import { checkDependenciesHealth, getWorldStatusInfo } from './football/coordinator';
import { eq, and, asc, desc, inArray, ilike, or, isNull, gt, sql } from 'drizzle-orm';
import { getPrimaryAdminCredential, verifyAdminPin, createAdminSessionToken, hashSessionToken, readAdminSessionTokenFromRequest, getAdminCookieOptions, resolveAdminSession, revokeAdminSession } from './admin/security';
import { coerceLeagueInput, coerceTeamInput } from './admin/operations';
import { z } from 'zod';
import {
  createSolanaPaymentOrder,
  getSolanaPaymentBlockhash,
  getSolanaPaymentConfig,
  getSolanaPaymentOrder,
  reconcileSolanaPaymentOrder,
  SolanaPaymentError,
  submitSolanaPaymentSignature,
} from './payments/solana-payment-service';

const placeBetRequestSchema = z.object({
  selections: z.array(z.object({
    fixtureId: z.string().uuid(),
    marketId: z.string().uuid(),
    outcomeCode: z.string().trim().min(1).max(80),
  }).strict()).min(1).max(20),
  stake: z.string().regex(/^\d{1,8}(?:\.\d{1,2})?$/),
  idempotencyKey: z.string().uuid(),
  ticketCode: z.string().regex(/^[A-Za-z0-9_-]{24}$/).optional(),
}).strict();
const ticketLookupRequestSchema = z.object({
  ticketCode: z.string().trim().max(24),
}).strict();
const adminUserSearchSchema = z.object({
  q: z.string().trim().max(200).optional().default(''),
  page: z.coerce.number().int().min(1).max(100_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(20),
}).strict();
const betHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000),
  pageSize: z.coerce.number().int().min(1).max(50),
  status: z.enum(['OPEN', 'SETTLED']),
}).strict();
const adminUserStatusSchema = z.object({
  action: z.enum(['suspend', 'restore']),
}).strict();

const adminAllowedOrigins = new Set(env.ADMIN_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean));
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'TOO_MANY_ATTEMPTS', message: 'Too many admin PIN attempts. Try again later.' },
});
const bookingCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'TOO_MANY_ATTEMPTS', message: 'Too many booking codes created. Try again later.' },
});
const bookingLookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'TOO_MANY_ATTEMPTS', message: 'Too many booking lookups. Try again later.' },
});
const ticketLookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'TOO_MANY_ATTEMPTS', message: 'Too many ticket lookups. Try again later.' },
});
const solanaOrderCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'TOO_MANY_ATTEMPTS', message: 'Too many payment orders created. Try again later.' },
});
const solanaPaymentStatusLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'TOO_MANY_ATTEMPTS', message: 'Too many payment status checks. Try again shortly.' },
});

const solanaOrderRequestSchema = z.object({
  packageId: z.enum(['credits-1000', 'credits-5000', 'custom']),
  creditAmount: z.number().int().min(1_000).max(100_000).multipleOf(10).optional(),
  payerAddress: z.string().min(32).max(64),
  idempotencyKey: z.string().uuid(),
}).strict().refine(
  (request) => request.packageId === 'custom'
    ? request.creditAmount !== undefined
    : request.creditAmount === undefined,
  { path: ['creditAmount'] },
);
const solanaSignatureRequestSchema = z.object({
  signature: z.string().min(80).max(90),
}).strict();

function publicSolanaOrder(order: Awaited<ReturnType<typeof createSolanaPaymentOrder>>) {
  return {
    id: order.id,
    packageId: order.packageId,
    creditAmount: order.creditAmount,
    usdCents: order.usdCents,
    solUsdPrice: order.solUsdPrice,
    priceProvider: order.priceProvider,
    priceObservedAt: order.priceObservedAt,
    priceFetchedAt: order.priceFetchedAt,
    expectedLamports: order.expectedLamports,
    network: order.network,
    treasuryAddress: order.treasuryAddress,
    payerAddress: order.payerAddress,
    referenceAddress: order.referenceAddress,
    status: order.status,
    transactionSignature: order.transactionSignature,
    reviewReason: order.reviewReason,
    expiresAt: order.expiresAt,
    verifiedAt: order.verifiedAt,
    creditedAt: order.creditedAt,
    createdAt: order.createdAt,
  };
}

function sendSolanaPaymentError(res: Response, error: unknown, action: string) {
  if (error instanceof SolanaPaymentError) {
    return res.status(error.statusCode).json({ error: error.code, message: error.message });
  }
  console.error(`${action} failed:`, error);
  return res.status(503).json({ error: 'SOLANA_PAYMENT_UNAVAILABLE', message: `${action} is temporarily unavailable. Try again.` });
}

async function attachBetTicketDetails(betRows: Array<typeof bets.$inferSelect>) {
  if (betRows.length === 0) return [];

  const betIds = betRows.map((bet) => bet.id);
  const selectionRows = await db.select().from(betSelections).where(inArray(betSelections.betId, betIds));
  const fixtureIds = [...new Set(selectionRows.map((selection) => selection.fixtureId))];
  const marketIds = [...new Set(selectionRows.map((selection) => selection.marketId))];
  const [fixtureRows, marketRows, outcomeRows, settlementRows] = await Promise.all([
    fixtureIds.length ? db.select().from(fixtures).where(inArray(fixtures.id, fixtureIds)) : Promise.resolve([]),
    marketIds.length ? db.select().from(markets).where(inArray(markets.id, marketIds)) : Promise.resolve([]),
    marketIds.length ? db.select().from(marketOutcomes).where(inArray(marketOutcomes.marketId, marketIds)) : Promise.resolve([]),
    db.select().from(settlements).where(inArray(settlements.betId, betIds)),
  ]);
  const teamIds = [...new Set(fixtureRows.flatMap((fixture) => [fixture.homeTeamId, fixture.awayTeamId]))];
  const teamRows = teamIds.length ? await db.select().from(teams).where(inArray(teams.id, teamIds)) : [];
  const selectionsByBet = new Map<string, typeof selectionRows>();
  for (const selection of selectionRows) {
    const rows = selectionsByBet.get(selection.betId) ?? [];
    rows.push(selection);
    selectionsByBet.set(selection.betId, rows);
  }
  const fixturesById = new Map(fixtureRows.map((fixture) => [fixture.id, fixture]));
  const teamsById = new Map(teamRows.map((team) => [team.id, team]));
  const marketsById = new Map(marketRows.map((market) => [market.id, market]));
  const outcomesByKey = new Map(outcomeRows.map((outcome) => [`${outcome.marketId}:${outcome.outcomeCode}`, outcome]));
  const settlementsByBet = new Map(settlementRows.map((settlement) => [settlement.betId, settlement]));

  return betRows.map(({ publicTicketCodeHash: _codeHash, ...bet }) => {
    const settlement = settlementsByBet.get(bet.id);
    return {
      ...bet,
      settlement: settlement ? { status: settlement.status, payoutAmount: settlement.payoutAmount } : null,
      selections: (selectionsByBet.get(bet.id) ?? []).map((selection) => {
        const fixture = fixturesById.get(selection.fixtureId);
        const market = marketsById.get(selection.marketId);
        const outcome = outcomesByKey.get(`${selection.marketId}:${selection.outcomeCode}`);
        return {
          ...selection,
          marketType: market?.marketType ?? 'Market',
          displayName: outcome?.displayName ?? selection.outcomeCode,
          fixture: fixture ? {
            scheduledAt: fixture.scheduledAt,
            status: fixture.status,
            homeScore: fixture.homeScore,
            awayScore: fixture.awayScore,
            homeTeam: teamsById.get(fixture.homeTeamId)?.name ?? 'Home team',
            awayTeam: teamsById.get(fixture.awayTeamId)?.name ?? 'Away team',
          } : null,
        };
      }),
    };
  });
}

function requireAdminOrigin(req: Request, res: Response, next: NextFunction) {
  const origin = req.get('Origin');
  if (!origin || !adminAllowedOrigins.has(origin)) {
    return res.status(403).json({ error: 'UNTRUSTED_ORIGIN', message: 'Admin requests must come from a configured origin.' });
  }
  return next();
}

async function requireAdminSession(req: Request, res: Response) {
  const token = readAdminSessionTokenFromRequest(req);
  const session = await resolveAdminSession(token);

  if (!session) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Admin session required.' });
    return null;
  }

  return session;
}

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors((req, callback) => {
    const origin = req.get('Origin');
    if (req.path.startsWith('/api/admin')) {
      if (!origin || !adminAllowedOrigins.has(origin)) return callback(null, { origin: false });
      return callback(null, { origin, credentials: true, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] });
    }
    return callback(null, { origin: origin || '*' });
  }));
  app.use(cookieParser());
  app.use(express.json());

  // 1. Health & World Status Endpoints
  app.get('/api/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'sim-soccer', environment: env.NODE_ENV, timestamp: new Date().toISOString() });
  });

  app.get('/api/health/live', (req: Request, res: Response) => {
    res.json({ status: 'live', service: 'sim-soccer', timestamp: new Date().toISOString() });
  });

  app.get('/api/health/ready', async (req: Request, res: Response) => {
    const health = await checkDependenciesHealth();
    if (health.postgres && health.redis && health.migrationOk) {
      res.json({ status: 'ready', dependencies: health });
    } else {
      res.status(503).json({ status: 'not_ready', dependencies: health });
    }
  });

  app.get('/api/world/status', async (req: Request, res: Response) => {
    const statusInfo = await getWorldStatusInfo();
    res.json(statusInfo);
  });

  app.get('/api/world/overview', async (req: Request, res: Response) => {
    const seasonNumberValue = req.query.seasonNumber;
    const requestedSeasonNumber = seasonNumberValue === undefined ? undefined : Number(seasonNumberValue);
    const roundValue = req.query.round;
    const requestedRound = roundValue === undefined ? undefined : Number(roundValue);

    if (
      (requestedSeasonNumber !== undefined && (!Number.isInteger(requestedSeasonNumber) || requestedSeasonNumber < 1))
      || (requestedRound !== undefined && (!Number.isInteger(requestedRound) || requestedRound < 1))
    ) {
      return res.status(400).json({ error: 'INVALID_OVERVIEW_QUERY', message: 'Season and round must be positive integers.' });
    }

    const [world, activeLeagues, allSeasons] = await Promise.all([
      getWorldStatusInfo(),
      db.select().from(leagues).where(eq(leagues.active, true)).orderBy(asc(leagues.name)),
      db.select({ seasonNumber: seasons.seasonNumber, name: seasons.name, totalRounds: seasons.totalRounds })
        .from(seasons)
        .orderBy(desc(seasons.seasonNumber)),
    ]);
    const availableSeasons = Array.from(
      new Map(allSeasons.map((season) => [season.seasonNumber, season])).values(),
    );

    const leagueOverviews = await Promise.all(activeLeagues.map(async (league) => {
      const seasonConditions = [eq(seasons.leagueId, league.id)];
      if (requestedSeasonNumber !== undefined) {
        seasonConditions.push(eq(seasons.seasonNumber, requestedSeasonNumber));
      } else {
        seasonConditions.push(eq(seasons.status, 'ACTIVE'));
      }
      const [season] = await db.select().from(seasons)
        .where(and(...seasonConditions))
        .limit(1);

      if (!season) {
        return { league, season: null, standings: [], roundFixtures: [], nextRoundFixtures: [], previousRoundFixtures: [] };
      }

      const selectedRound = Math.min(requestedRound ?? season.currentRound, season.totalRounds);
      const nextRound = selectedRound < season.totalRounds ? selectedRound + 1 : null;
      const previousRound = selectedRound > 1 ? selectedRound - 1 : null;
      const nextRoundQuery = nextRound === null
        ? Promise.resolve([])
        : db.select().from(fixtures)
          .where(and(eq(fixtures.seasonId, season.id), eq(fixtures.round, nextRound)))
          .orderBy(asc(fixtures.scheduledAt), asc(fixtures.id));
      const previousRoundQuery = previousRound === null
        ? Promise.resolve([])
        : db.select().from(fixtures)
          .where(and(eq(fixtures.seasonId, season.id), eq(fixtures.round, previousRound)))
          .orderBy(asc(fixtures.scheduledAt), asc(fixtures.id));
      const [tableRows, roundFixtures, nextRoundFixtures, previousRoundFixtures, leagueTeams] = await Promise.all([
        db.select({
          teamId: teams.id,
          teamName: teams.name,
          shortName: teams.shortName,
          slug: teams.slug,
          played: standings.played,
          won: standings.won,
          drawn: standings.drawn,
          lost: standings.lost,
          goalsFor: standings.goalsFor,
          goalsAgainst: standings.goalsAgainst,
          goalDifference: standings.goalDifference,
          points: standings.points,
        })
          .from(standings)
          .innerJoin(teams, eq(standings.teamId, teams.id))
          .where(eq(standings.seasonId, season.id))
          .orderBy(desc(standings.points), desc(standings.goalDifference), desc(standings.goalsFor), asc(teams.name)),
        db.select().from(fixtures)
        .where(and(eq(fixtures.seasonId, season.id), eq(fixtures.round, selectedRound)))
        .orderBy(asc(fixtures.scheduledAt), asc(fixtures.id)),
        nextRoundQuery,
        previousRoundQuery,
        db.select({ id: teams.id, name: teams.name, shortName: teams.shortName, slug: teams.slug })
          .from(teams)
          .where(eq(teams.leagueId, league.id)),
      ]);

      const teamById = new Map(leagueTeams.map((team) => [team.id, team]));
      const allVisibleFixtures = [...roundFixtures, ...nextRoundFixtures, ...previousRoundFixtures];
      const fixtureIds = allVisibleFixtures.map((fixture) => fixture.id);
      const [matchRows, eventRows, statisticsRows] = fixtureIds.length === 0
        ? [[], [], []]
        : await Promise.all([
          db.select({
            fixtureId: matches.fixtureId,
            status: matches.status,
            virtualSecond: matches.virtualSecond,
            updatedAt: matches.updatedAt,
          })
            .from(matches)
            .where(inArray(matches.fixtureId, fixtureIds)),
          db.select({
            fixtureId: matchEvents.fixtureId,
            sequence: matchEvents.sequence,
            virtualMinute: matchEvents.virtualMinute,
            virtualSecond: matchEvents.virtualSecond,
            eventType: matchEvents.eventType,
            teamId: matchEvents.teamId,
            playerId: matchEvents.playerId,
            playerName: players.name,
            metadata: matchEvents.metadata,
            createdAt: matchEvents.createdAt,
          })
            .from(matchEvents)
            .leftJoin(players, eq(matchEvents.playerId, players.id))
            .where(inArray(matchEvents.fixtureId, fixtureIds))
            .orderBy(asc(matchEvents.fixtureId), asc(matchEvents.sequence)),
          db.select().from(matchStatistics).where(inArray(matchStatistics.fixtureId, fixtureIds)),
        ]);
      const matchByFixtureId = new Map(matchRows.map((match) => [match.fixtureId, match]));
      const eventsByFixtureId = new Map<string, typeof eventRows>();
      for (const event of eventRows) {
        const fixtureEvents = eventsByFixtureId.get(event.fixtureId) ?? [];
        fixtureEvents.push(event);
        eventsByFixtureId.set(event.fixtureId, fixtureEvents);
      }
      const statisticsByFixtureId = new Map(statisticsRows.map((statistics) => [statistics.fixtureId, statistics]));

      const formatFixture = (fixture: typeof fixtures.$inferSelect) => {
        const match = matchByFixtureId.get(fixture.id);
        const fixtureEvents = eventsByFixtureId.get(fixture.id) ?? [];
        return {
          id: fixture.id,
          round: fixture.round,
          status: fixture.status === 'FINISHED' || match?.status === 'FINISHED' ? 'FINISHED' : fixture.status,
          matchStatus: match?.status ?? null,
          scheduledAt: fixture.scheduledAt,
          startedAt: fixture.startedAt,
          finishedAt: fixture.finishedAt,
          homeScore: fixture.homeScore ?? 0,
          awayScore: fixture.awayScore ?? 0,
          virtualSecond: match?.virtualSecond ?? 0,
          clockUpdatedAt: match?.updatedAt ?? null,
          goalEvents: fixtureEvents.filter((event) => event.eventType === 'GOAL').map((goal) => ({
            sequence: goal.sequence,
            minute: goal.virtualMinute,
            teamId: goal.teamId,
            playerName: goal.playerName,
            createdAt: goal.createdAt,
          })),
          matchEvents: fixtureEvents.map((event) => ({
            sequence: event.sequence,
            virtualMinute: event.virtualMinute,
            virtualSecond: event.virtualSecond,
            eventType: event.eventType,
            teamId: event.teamId,
            playerId: event.playerId,
            playerName: event.playerName,
            metadata: event.metadata,
            createdAt: event.createdAt,
          })),
          matchStatistics: statisticsByFixtureId.get(fixture.id) ?? null,
          homeTeam: teamById.get(fixture.homeTeamId) ?? null,
          awayTeam: teamById.get(fixture.awayTeamId) ?? null,
        };
      };

      return {
        league,
        season: {
          id: season.id,
          name: season.name,
          seasonNumber: season.seasonNumber,
          currentRound: season.currentRound,
          totalRounds: season.totalRounds,
        },
        standings: tableRows.map((row, index) => ({ position: index + 1, ...row })),
        roundFixtures: roundFixtures.map(formatFixture),
        nextRoundFixtures: nextRoundFixtures.map(formatFixture),
        previousRoundFixtures: previousRoundFixtures.map(formatFixture),
      };
    }));

    res.json({ generatedAt: new Date().toISOString(), world, leagues: leagueOverviews, availableSeasons });
  });

  app.post('/api/admin/login', adminLoginLimiter, requireAdminOrigin, async (req: Request, res: Response) => {
    try {
      const { pin } = req.body ?? {};
      if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
        return res.status(400).json({ error: 'INVALID_PIN', message: 'Enter the four-digit admin PIN.' });
      }

      const credential = await getPrimaryAdminCredential();
      if (!credential) {
        return res.status(503).json({ error: 'ADMIN_NOT_INITIALIZED', message: 'Run the one-time admin bootstrap command first.' });
      }
      const now = new Date();
      if (credential.lockedUntil && new Date(credential.lockedUntil).getTime() > now.getTime()) {
        return res.status(423).json({ error: 'PIN_LOCKED', message: 'Admin pin is temporarily locked.' });
      }

      if (!verifyAdminPin(pin, credential.pinHash)) {
        const failedAttempts = (credential.failedAttempts ?? 0) + 1;
        const lockoutUntil = failedAttempts >= 5 ? new Date(now.getTime() + 15 * 60 * 1000) : null;
        await db.update(adminCredentials)
          .set({
            failedAttempts,
            lockedUntil: lockoutUntil,
            updatedAt: now,
          })
          .where(eq(adminCredentials.id, 'primary'));

        return res.status(401).json({ error: 'INVALID_PIN', message: 'Incorrect admin pin.' });
      }

      await db.update(adminCredentials)
        .set({
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: now,
        })
        .where(eq(adminCredentials.id, 'primary'));

      const token = createAdminSessionToken('primary');
      const nowTs = Date.now();
      const idleExpiresAt = new Date(nowTs + 30 * 60 * 1000);
      const absoluteExpiresAt = new Date(nowTs + 8 * 60 * 60 * 1000);

      await db.insert(adminSessions).values({
        tokenHash: hashSessionToken(token),
        createdAt: now,
        lastSeenAt: now,
        idleExpiresAt,
        absoluteExpiresAt,
        revokedAt: null,
      });

      res.cookie('sim_admin_session', token, getAdminCookieOptions());
      res.json({
        ok: true,
        user: { id: 'primary', role: 'admin' },
        session: {
          idleExpiresAt: idleExpiresAt.toISOString(),
          absoluteExpiresAt: absoluteExpiresAt.toISOString(),
        },
      });
    } catch (error: any) {
      console.error('Admin login failed:', error);
      res.status(503).json({ error: 'ADMIN_LOGIN_UNAVAILABLE', message: error.message || 'Admin login is unavailable right now.' });
    }
  });

  app.post('/api/admin/logout', requireAdminOrigin, async (req: Request, res: Response) => {
    const token = readAdminSessionTokenFromRequest(req);
    if (token) {
      await revokeAdminSession(token);
    }

    res.clearCookie('sim_admin_session', {
      path: '/',
      sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
      secure: env.NODE_ENV === 'production',
    });
    res.json({ ok: true });
  });

  app.get('/api/admin/me', async (req: Request, res: Response) => {
    const token = readAdminSessionTokenFromRequest(req);
    const session = await resolveAdminSession(token);

    if (!session) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Admin session required.' });
    }

    return res.json({ user: { id: 'primary', role: 'admin' }, session: { id: session.id, idleExpiresAt: session.idleExpiresAt, absoluteExpiresAt: session.absoluteExpiresAt } });
  });

  app.get('/api/admin/solana-payments/review', async (req: Request, res: Response) => {
    const session = await requireAdminSession(req, res);
    if (!session) return;
    const limit = z.coerce.number().int().min(1).max(100).catch(50).parse(req.query.limit);
    try {
      const orders = await db.select().from(solanaPaymentOrders)
        .where(or(
          inArray(solanaPaymentOrders.status, ['EXPIRED', 'FAILED', 'UNDERPAID', 'OVERPAID', 'REQUIRES_REVIEW']),
          inArray(
            solanaPaymentOrders.id,
            db.select({ orderId: solanaPaymentAttempts.orderId })
              .from(solanaPaymentAttempts)
              .where(inArray(solanaPaymentAttempts.status, ['FAILED', 'UNDERPAID', 'OVERPAID', 'REQUIRES_REVIEW'])),
          ),
        ))
        .orderBy(desc(solanaPaymentOrders.updatedAt))
        .limit(limit);
      const orderIds = orders.map((order) => order.id);
      const attempts = orderIds.length
        ? await db.select().from(solanaPaymentAttempts)
          .where(inArray(solanaPaymentAttempts.orderId, orderIds))
          .orderBy(desc(solanaPaymentAttempts.observedAt))
        : [];
      return res.json({ orders, attempts });
    } catch (error) {
      console.error('Solana payment review queue failed:', error);
      return res.status(503).json({ error: 'PAYMENT_REVIEW_UNAVAILABLE', message: 'The payment review queue is temporarily unavailable.' });
    }
  });

  app.get('/api/admin/summary', async (req: Request, res: Response) => {
    const session = await requireAdminSession(req, res);
    if (!session) return;

    try {
      const [world, leaguesList, seasonsList, teamsList, fixturesList, auditRows] = await Promise.all([
        getWorldStatusInfo(),
        db.select().from(leagues),
        db.select().from(seasons),
        db.select().from(teams),
        db.select().from(fixtures),
        db.select().from(adminAuditLog).orderBy(desc(adminAuditLog.createdAt)).limit(20),
      ]);

      res.json({
        ok: true,
        world,
        counts: {
          leagues: leaguesList.length,
          seasons: seasonsList.length,
          teams: teamsList.length,
          fixtures: fixturesList.length,
        },
        recentAudit: auditRows,
      });
    } catch (error: any) {
      console.error('Admin summary failed:', error);
      res.status(503).json({ error: 'ADMIN_SUMMARY_UNAVAILABLE', message: error.message || 'Admin summary unavailable.' });
    }
  });

  app.get('/api/admin/users', async (req: Request, res: Response) => {
    const session = await requireAdminSession(req, res);
    if (!session) return;
    const parsed = adminUserSearchSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID_USER_SEARCH', message: 'Enter a search term and valid page.' });
    }
    const { q, page, pageSize } = parsed.data;
    const searchTerm = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : '';
    const conditions = searchTerm
      ? [or(
        ilike(users.email, searchTerm),
        ilike(users.firstName, searchTerm),
        ilike(users.lastName, searchTerm),
        ...(z.string().uuid().safeParse(q).success ? [eq(users.id, q)] : []),
      )!]
      : [];
    const where = conditions.length ? and(...conditions) : undefined;
    try {
      const [countRows, records] = await Promise.all([
        db.select({ total: sql<number>`count(*)::int` }).from(users).where(where),
        db.select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          accountStatus: users.accountStatus,
          createdAt: users.createdAt,
          walletBalance: wallets.balance,
          currency: wallets.currency,
        })
          .from(users)
          .leftJoin(wallets, eq(wallets.userId, users.id))
          .where(where)
          .orderBy(desc(users.createdAt), desc(users.id))
          .limit(pageSize)
          .offset((page - 1) * pageSize),
      ]);
      return res.json({
        users: records,
        page,
        pageSize,
        total: Number(countRows[0]?.total ?? 0),
      });
    } catch (error) {
      console.error('Admin user search failed:', error);
      return res.status(503).json({ error: 'ADMIN_USER_SEARCH_UNAVAILABLE', message: 'Accounts could not be loaded. Try again.' });
    }
  });

  app.get('/api/admin/users/:userId', async (req: Request, res: Response) => {
    const session = await requireAdminSession(req, res);
    if (!session) return;
    const userId = z.string().uuid().safeParse(req.params.userId);
    if (!userId.success) return res.status(400).json({ error: 'INVALID_USER_ID', message: 'Choose a valid account.' });
    try {
      const [account] = await db.select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        phone: users.phone,
        accountStatus: users.accountStatus,
        createdAt: users.createdAt,
        suspendedAt: users.suspendedAt,
        anonymizedAt: users.anonymizedAt,
        walletBalance: wallets.balance,
        currency: wallets.currency,
      })
        .from(users)
        .leftJoin(wallets, eq(wallets.userId, users.id))
        .where(eq(users.id, userId.data))
        .limit(1);
      if (!account) return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'That account could not be found.' });

      const [betCount, activeSessionCount, transactionCount, recentBets, recentTransactions] = await Promise.all([
        db.select({ total: sql<number>`count(*)::int` }).from(bets).where(eq(bets.userId, account.id)),
        db.select({ total: sql<number>`count(*)::int` }).from(authSessions)
          .where(and(eq(authSessions.userId, account.id), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, new Date()))),
        db.select({ total: sql<number>`count(*)::int` }).from(walletTransactions)
          .innerJoin(wallets, eq(walletTransactions.walletId, wallets.id))
          .where(eq(wallets.userId, account.id)),
        db.select({ id: bets.id, stake: bets.stake, status: bets.status, placedAt: bets.placedAt, settledAt: bets.settledAt })
          .from(bets).where(eq(bets.userId, account.id)).orderBy(desc(bets.placedAt)).limit(10),
        db.select({
          id: walletTransactions.id,
          type: walletTransactions.type,
          amount: walletTransactions.amount,
          balanceAfter: walletTransactions.balanceAfter,
          createdAt: walletTransactions.createdAt,
        })
          .from(walletTransactions)
          .innerJoin(wallets, eq(walletTransactions.walletId, wallets.id))
          .where(eq(wallets.userId, account.id))
          .orderBy(desc(walletTransactions.createdAt))
          .limit(10),
      ]);
      return res.json({
        account,
        counts: {
          bets: Number(betCount[0]?.total ?? 0),
          activeSessions: Number(activeSessionCount[0]?.total ?? 0),
          walletTransactions: Number(transactionCount[0]?.total ?? 0),
        },
        recentBets,
        recentTransactions,
      });
    } catch (error) {
      console.error('Admin user details failed:', error);
      return res.status(503).json({ error: 'ADMIN_USER_DETAILS_UNAVAILABLE', message: 'Account details could not be loaded. Try again.' });
    }
  });

  app.patch('/api/admin/users/:userId/status', requireAdminOrigin, async (req: Request, res: Response) => {
    const session = await requireAdminSession(req, res);
    if (!session) return;
    const userId = z.string().uuid().safeParse(req.params.userId);
    const parsed = adminUserStatusSchema.safeParse(req.body ?? {});
    if (!userId.success || !parsed.success) {
      return res.status(400).json({ error: 'INVALID_ACCOUNT_ACTION', message: 'Choose a valid account action.' });
    }
    try {
      const account = await db.transaction(async (tx) => {
        const [target] = await tx.select({
          id: users.id,
          email: users.email,
          role: users.role,
          accountStatus: users.accountStatus,
        }).from(users).where(eq(users.id, userId.data)).for('update').limit(1);
        if (!target) return { error: 'not_found' as const };
        if (target.role !== 'USER' || target.accountStatus === 'ANONYMIZED') return { error: 'not_manageable' as const };
        if (parsed.data.action === 'suspend' && target.accountStatus === 'SUSPENDED') return { error: 'already_suspended' as const };
        if (parsed.data.action === 'restore' && target.accountStatus !== 'SUSPENDED') return { error: 'not_suspended' as const };

        const now = new Date();
        const suspended = parsed.data.action === 'suspend';
        const [updated] = await tx.update(users).set({
          accountStatus: suspended ? 'SUSPENDED' : 'ACTIVE',
          suspendedAt: suspended ? now : null,
          suspendedBy: suspended ? 'primary' : null,
          updatedAt: now,
        }).where(eq(users.id, target.id)).returning({
          id: users.id,
          email: users.email,
          accountStatus: users.accountStatus,
          suspendedAt: users.suspendedAt,
        });
        if (suspended) {
          await tx.update(authSessions).set({ revokedAt: now })
            .where(and(eq(authSessions.userId, target.id), isNull(authSessions.revokedAt)));
          await tx.update(authDevices).set({ revokedAt: now })
            .where(and(eq(authDevices.userId, target.id), isNull(authDevices.revokedAt)));
          await tx.update(authChallenges).set({ consumedAt: now })
            .where(and(eq(authChallenges.userId, target.id), isNull(authChallenges.consumedAt)));
        }
        await tx.insert(adminAuditLog).values({
          actor: 'primary',
          action: suspended ? 'user.suspend' : 'user.restore',
          targetType: 'user',
          targetId: target.id,
          summary: suspended ? 'Customer account suspended.' : 'Customer account restored.',
          metadata: {},
        });
        return { account: updated };
      });
      if ('error' in account) {
        const status = account.error === 'not_found' ? 404 : 409;
        const message = account.error === 'not_found' ? 'That account could not be found.'
          : account.error === 'already_suspended' ? 'That account is already suspended.'
            : account.error === 'not_suspended' ? 'That account is not suspended.'
              : 'This account cannot be changed.';
        return res.status(status).json({ error: 'ACCOUNT_ACTION_NOT_ALLOWED', message });
      }
      return res.json(account);
    } catch (error) {
      console.error('Admin account status update failed:', error);
      return res.status(503).json({ error: 'ACCOUNT_ACTION_FAILED', message: 'The account could not be updated. Try again.' });
    }
  });

  app.post('/api/admin/users/:userId/anonymize', requireAdminOrigin, async (req: Request, res: Response) => {
    const session = await requireAdminSession(req, res);
    if (!session) return;
    const userId = z.string().uuid().safeParse(req.params.userId);
    const confirmation = z.object({ confirmation: z.string().trim().min(10).max(300) }).strict().safeParse(req.body ?? {});
    if (!userId.success || !confirmation.success) {
      return res.status(400).json({ error: 'ANONYMIZATION_CONFIRMATION_REQUIRED', message: 'Confirm anonymization to continue.' });
    }
    try {
      const outcome = await db.transaction(async (tx) => {
        const [target] = await tx.select({
          id: users.id,
          email: users.email,
          accountStatus: users.accountStatus,
          role: users.role,
        }).from(users).where(eq(users.id, userId.data)).for('update').limit(1);
        if (!target) return 'not_found' as const;
        if (target.role !== 'USER' || target.accountStatus !== 'SUSPENDED') return 'must_suspend' as const;
        if (confirmation.data.confirmation !== `ANONYMIZE ${target.email}`) return 'confirmation_mismatch' as const;

        const now = new Date();
        await tx.update(authSessions).set({ revokedAt: now })
          .where(and(eq(authSessions.userId, target.id), isNull(authSessions.revokedAt)));
        await tx.update(authDevices).set({ revokedAt: now })
          .where(and(eq(authDevices.userId, target.id), isNull(authDevices.revokedAt)));
        await tx.update(bets).set({ publicTicketCodeHash: null }).where(eq(bets.userId, target.id));
        await tx.update(users).set({
          email: `anonymized+${target.id}+${randomUUID()}@invalid.simsoccer`,
          authSubject: null,
          passwordHash: null,
          isEmailVerified: false,
          firstName: null,
          lastName: null,
          phone: null,
          privacyNoticeVersion: null,
          termsAcceptedAt: null,
          accountStatus: 'ANONYMIZED',
          anonymizedAt: now,
          updatedAt: now,
        }).where(eq(users.id, target.id));
        await tx.insert(adminAuditLog).values({
          actor: 'primary',
          action: 'user.anonymize',
          targetType: 'user',
          targetId: target.id,
          summary: 'Customer account personal details anonymized; financial and betting history retained.',
          metadata: { retained: ['wallet', 'wallet_transactions', 'bets', 'settlements'] },
        });
        await tx.delete(authSessions).where(eq(authSessions.userId, target.id));
        await tx.delete(authDevices).where(eq(authDevices.userId, target.id));
        await tx.delete(authChallenges).where(eq(authChallenges.userId, target.id));
        return 'ok' as const;
      });
      if (outcome === 'not_found') return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'That account could not be found.' });
      if (outcome === 'must_suspend') return res.status(409).json({ error: 'SUSPENSION_REQUIRED', message: 'Suspend this account before anonymizing it.' });
      if (outcome === 'confirmation_mismatch') return res.status(400).json({ error: 'ANONYMIZATION_CONFIRMATION_MISMATCH', message: 'Type the account email confirmation exactly.' });
      return res.json({ ok: true, message: 'Account details anonymized. Betting and wallet history were kept.' });
    } catch (error) {
      console.error('Admin account anonymization failed:', error);
      return res.status(503).json({ error: 'ACCOUNT_ANONYMIZATION_FAILED', message: 'The account details could not be anonymized. Try again.' });
    }
  });

  app.get('/api/admin/leagues', async (req: Request, res: Response) => {
    const session = await requireAdminSession(req, res);
    if (!session) return;

    const allLeagues = await db.select().from(leagues).orderBy(asc(leagues.name));
    res.json(allLeagues);
  });

  app.post('/api/admin/leagues', requireAdminOrigin, async (req: Request, res: Response) => {
    const session = await requireAdminSession(req, res);
    if (!session) return;

    try {
      const payload = coerceLeagueInput(req.body ?? {});
      if (!payload.name) {
        return res.status(400).json({ error: 'INVALID_LEAGUE', message: 'League name is required.' });
      }

      const existingId = typeof req.body?.id === 'string' ? req.body.id : null;
      let record: any;

      if (existingId) {
        const [updated] = await db.update(leagues)
          .set({
            name: payload.name,
            slug: payload.slug,
            country: payload.country,
            competitionType: payload.competitionType,
            teamCount: payload.teamCount,
            active: payload.active,
            updatedAt: new Date(),
          })
          .where(eq(leagues.id, existingId))
          .returning();

        record = updated;
      } else {
        const [created] = await db.insert(leagues).values({
          name: payload.name,
          slug: payload.slug,
          country: payload.country,
          competitionType: payload.competitionType,
          teamCount: payload.teamCount,
          active: payload.active,
        }).returning();

        record = created;
      }

      await db.insert(adminAuditLog).values({
        actor: 'primary',
        action: existingId ? 'league.update' : 'league.create',
        targetType: 'league',
        targetId: record.id,
        summary: `League ${payload.name} ${existingId ? 'updated' : 'created'} by admin control room.`,
        metadata: { league: record },
      });

      return res.status(200).json(record);
    } catch (error: any) {
      console.error('Admin league save failed:', error);
      return res.status(500).json({ error: 'ADMIN_LEAGUE_SAVE_FAILED', message: error.message || 'Unable to save league.' });
    }
  });

  app.get('/api/admin/teams', async (req: Request, res: Response) => {
    const session = await requireAdminSession(req, res);
    if (!session) return;

    const activeSeasons = await db.select({ id: seasons.id, name: seasons.name, seasonNumber: seasons.seasonNumber })
      .from(seasons)
      .where(eq(seasons.status, 'ACTIVE'));
    const seasonIds = activeSeasons.map((season) => season.id);
    const ratingRows = seasonIds.length === 0 ? [] : await db.select({
      teamId: teamRatings.teamId,
      seasonId: teamRatings.seasonId,
      overallAbility: teamRatings.overallAbility,
      attackStrength: teamRatings.attackStrength,
      defenseStrength: teamRatings.defenseStrength,
      creationRating: teamRatings.creationRating,
      finishingRating: teamRatings.finishingRating,
      goalkeepingRating: teamRatings.goalkeepingRating,
      pressingRating: teamRatings.pressingRating,
      disciplineRating: teamRatings.disciplineRating,
      homeAdvantage: teamRatings.homeAdvantage,
      form: teamRatings.form,
    })
      .from(teamRatings)
      .where(inArray(teamRatings.seasonId, seasonIds));
    const seasonById = new Map(activeSeasons.map((season) => [season.id, season]));
    const ratingsByTeamId = new Map<string, Array<Record<string, unknown>>>();

    for (const rating of ratingRows) {
      const season = seasonById.get(rating.seasonId);
      const teamRatingsForTeam = ratingsByTeamId.get(rating.teamId) ?? [];
      teamRatingsForTeam.push({
        seasonId: rating.seasonId,
        seasonName: season?.name,
        seasonNumber: season?.seasonNumber,
        overallAbility: Number(rating.overallAbility),
        attackStrength: Number(rating.attackStrength),
        defenseStrength: Number(rating.defenseStrength),
        creationRating: Number(rating.creationRating),
        finishingRating: Number(rating.finishingRating),
        goalkeepingRating: Number(rating.goalkeepingRating),
        pressingRating: Number(rating.pressingRating),
        disciplineRating: Number(rating.disciplineRating),
        homeAdvantage: Number(rating.homeAdvantage),
        form: Number(rating.form),
      });
      ratingsByTeamId.set(rating.teamId, teamRatingsForTeam);
    }

    const teamRows = await db.select({
      id: teams.id,
      leagueId: teams.leagueId,
      name: teams.name,
      shortName: teams.shortName,
      slug: teams.slug,
      stadiumName: teams.stadiumName,
      active: teams.active,
      leagueName: leagues.name,
    })
      .from(teams)
      .leftJoin(leagues, eq(teams.leagueId, leagues.id))
      .orderBy(asc(teams.name));

    res.json(teamRows.map((team) => ({
      ...team,
      ratings: ratingsByTeamId.get(team.id) ?? [],
    })));
  });

  app.post('/api/admin/teams', requireAdminOrigin, async (req: Request, res: Response) => {
    const session = await requireAdminSession(req, res);
    if (!session) return;

    try {
      const payload = coerceTeamInput(req.body ?? {});
      if (!payload.name || !payload.leagueId) {
        return res.status(400).json({ error: 'INVALID_TEAM', message: 'Team name and league are required.' });
      }

      const existingId = typeof req.body?.id === 'string' ? req.body.id : null;
      let record: any;

      if (existingId) {
        const [updated] = await db.update(teams)
          .set({
            leagueId: payload.leagueId,
            name: payload.name,
            shortName: payload.shortName,
            slug: payload.slug,
            stadiumName: payload.stadiumName,
            active: payload.active,
            updatedAt: new Date(),
          })
          .where(eq(teams.id, existingId))
          .returning();

        record = updated;
      } else {
        const [created] = await db.insert(teams).values({
          leagueId: payload.leagueId,
          name: payload.name,
          shortName: payload.shortName,
          slug: payload.slug,
          stadiumName: payload.stadiumName,
          active: payload.active,
        }).returning();

        record = created;
      }

      await db.insert(adminAuditLog).values({
        actor: 'primary',
        action: existingId ? 'team.update' : 'team.create',
        targetType: 'team',
        targetId: record.id,
        summary: `Team ${payload.name} ${existingId ? 'updated' : 'created'} by admin control room.`,
        metadata: { team: record },
      });

      return res.status(200).json(record);
    } catch (error: any) {
      console.error('Admin team save failed:', error);
      return res.status(500).json({ error: 'ADMIN_TEAM_SAVE_FAILED', message: error.message || 'Unable to save team.' });
    }
  });

  app.get('/api/health/database', async (req: Request, res: Response) => {
    try {
      await db.execute(db.select().from(leagues).limit(1));
      res.json({ status: 'ok', database: 'connected' });
    } catch (err: any) {
      res.status(500).json({ status: 'error', database: err.message });
    }
  });

  // 2. Leagues & Seasons API
  app.get('/api/leagues', async (req: Request, res: Response) => {
    const allLeagues = await db.select().from(leagues);
    res.json(allLeagues);
  });

  app.get('/api/seasons', async (req: Request, res: Response) => {
    const allSeasons = await db.select().from(seasons);
    res.json(allSeasons);
  });

  // 3. Fixtures & Matches API
  app.get('/api/fixtures', async (req: Request, res: Response) => {
    const seasonId = req.query.seasonId as string;
    const allFixtures = seasonId
      ? await db.select().from(fixtures).where(eq(fixtures.seasonId, seasonId))
      : await db.select().from(fixtures).limit(50);
    res.json(allFixtures);
  });

  app.get('/api/fixtures/:id', async (req: Request, res: Response) => {
    const fixtureId = req.params.id as string;
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    if (!fixture) return res.status(404).json({ error: 'Fixture not found' });
    res.json(fixture);
  });

  app.get('/api/fixtures/:id/events', async (req: Request, res: Response) => {
    const fixtureId = req.params.id as string;
    const events = await db.select().from(matchEvents)
      .where(eq(matchEvents.fixtureId, fixtureId))
      .orderBy(asc(matchEvents.sequence));
    res.json(events);
  });

  // 4. Markets API — Dynamically derived from team ratings
  app.get('/api/betting/markets', async (req: Request, res: Response) => {
    try {
      const roundValue = req.query.round;
      const round = roundValue === undefined ? undefined : Number(roundValue);
      const leagueId = typeof req.query.leagueId === 'string' ? req.query.leagueId : undefined;
      const result = await listBettingMarkets(round, leagueId);
      return res.json(result);
    } catch (err: any) {
      return res.status(400).json({ error: 'MARKET_QUERY_FAILED', message: err.message });
    }
  });

  app.get('/api/betting/fixtures/:fixtureId/statistics', bookingLookupLimiter, async (req: Request, res: Response) => {
    try {
      const statistics = await getFixtureStatistics(req.params.fixtureId as string);
      if (!statistics) return res.status(404).json({ error: 'FIXTURE_NOT_FOUND', message: 'Fixture not found.' });
      return res.json(statistics);
    } catch (err: any) {
      return res.status(400).json({ error: 'FIXTURE_STATISTICS_FAILED', message: err.message });
    }
  });

  app.post('/api/betting/bookings', bookingCreateLimiter, async (req: Request, res: Response) => {
    try {
      const selections = req.body?.selections;
      if (!Array.isArray(selections) || selections.some((selection) =>
        typeof selection?.fixtureId !== 'string'
        || typeof selection?.marketId !== 'string'
        || typeof selection?.outcomeCode !== 'string'
      )) {
        return res.status(400).json({ error: 'INVALID_BOOKING', message: 'Provide fixtureId, marketId, and outcomeCode for every selection.' });
      }
      const booking = await createBookingSlip(selections);
      return res.status(201).json(booking);
    } catch (err: any) {
      return res.status(400).json({ error: 'BOOKING_CREATE_FAILED', message: err.message });
    }
  });

  app.get('/api/betting/bookings/:code', bookingLookupLimiter, async (req: Request, res: Response) => {
    try {
      const booking = await loadBookingSlip(req.params.code as string);
      return res.json(booking);
    } catch (err: any) {
      const notFound = err.message === 'Booking code not found.';
      return res.status(notFound ? 404 : 400).json({ error: notFound ? 'BOOKING_NOT_FOUND' : 'BOOKING_LOAD_FAILED', message: err.message });
    }
  });

  app.get('/api/fixtures/:id/markets', async (req: Request, res: Response) => {
    const fixtureId = req.params.id as string;
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    if (!fixture) return res.status(404).json({ error: 'FIXTURE_NOT_FOUND', message: 'Fixture not found.' });

    const existingMarkets = await db.select().from(markets).where(eq(markets.fixtureId, fixtureId));
    const marketIds = existingMarkets.map((market) => market.id);
    const outcomes = marketIds.length === 0
      ? []
      : await db.select().from(marketOutcomes).where(inArray(marketOutcomes.marketId, marketIds));
    return res.json(existingMarkets.map((market) => ({
      ...market,
      outcomes: outcomes.filter((outcome) => outcome.marketId === market.id),
    })));
  });

  // 5. Betting API
  app.post('/api/bets', authenticateJwt, requireLocalAccount, async (req: AuthenticatedRequest, res: Response) => {
    const parsed = placeBetRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID_BET', message: 'Check the stake and selected market.' });
    }

    try {
      const bet = await placePlayMoneyBet({
        userId: req.user!.id,
        ...parsed.data,
      });

      return res.status(201).json(bet);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const safeMessage = message === 'Wallet balance is insufficient.'
        || message === 'Minimum stake is 100 credits.'
        ? message
        : message === 'Betting for this round is closed.' || message === 'Fixture is outside the current betting rounds.'
          ? message
          : message === 'Selected odds are no longer available.'
            || message === 'One or more fixtures are not available for betting.'
            || message === 'All selections must belong to the same world round.'
            || message === 'A straight multiple can include only one selection per fixture.'
            ? message
            : null;
      if (safeMessage) return res.status(409).json({ error: 'BET_NOT_ACCEPTED', message: safeMessage });
      console.error('Bet placement failed:', error);
      return res.status(503).json({ error: 'BETTING_UNAVAILABLE', message: 'Betting is temporarily unavailable. Try again.' });
    }
  });

  app.get('/api/bets', authenticateJwt, requireLocalAccount, async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (Object.keys(req.query).length > 0) {
        const parsed = betHistoryQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          return res.status(400).json({ error: 'INVALID_BET_HISTORY_QUERY', message: 'Check the requested bet history page.' });
        }
        const { page, pageSize, status } = parsed.data;
        const statusFilter = status === 'OPEN'
          ? eq(bets.status, 'PENDING')
          : sql`${bets.status} <> 'PENDING'`;
        const userFilter = and(eq(bets.userId, req.user!.id), statusFilter);
        const [userBets, countResult, openCountResult] = await Promise.all([
          db.select().from(bets)
            .where(userFilter)
            .orderBy(desc(bets.placedAt), desc(bets.id))
            .limit(pageSize)
            .offset((page - 1) * pageSize),
          db.select({ total: sql<number>`count(*)::int` }).from(bets).where(userFilter),
          db.select({ total: sql<number>`count(*)::int` }).from(bets)
            .where(and(eq(bets.userId, req.user!.id), eq(bets.status, 'PENDING'))),
        ]);
        const total = countResult[0]?.total ?? 0;
        return res.json({
          tickets: await attachBetTicketDetails(userBets),
          total,
          openCount: openCountResult[0]?.total ?? 0,
          page,
          pageSize,
          hasMore: page * pageSize < total,
        });
      }

      const userBets = await db.select().from(bets)
        .where(eq(bets.userId, req.user!.id))
        .orderBy(desc(bets.placedAt))
        .limit(100);
      return res.json(await attachBetTicketDetails(userBets));
    } catch (error) {
      console.error('Bet history lookup failed:', error);
      return res.status(503).json({ error: 'BET_HISTORY_UNAVAILABLE', message: 'Bet history is temporarily unavailable.' });
    }
  });

  app.get('/api/bets/:betId', authenticateJwt, requireLocalAccount, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const [bet] = await db.select().from(bets)
        .where(and(eq(bets.id, req.params.betId as string), eq(bets.userId, req.user!.id)))
        .limit(1);
      if (!bet) return res.status(404).json({ error: 'BET_NOT_FOUND', message: 'Bet ticket was not found.' });
      const [ticket] = await attachBetTicketDetails([bet]);
      return res.json(ticket);
    } catch (error) {
      console.error('Bet ticket lookup failed:', error);
      return res.status(503).json({ error: 'BET_TICKET_UNAVAILABLE', message: 'Bet ticket is temporarily unavailable.' });
    }
  });

  app.post('/api/bets/lookup', ticketLookupLimiter, async (req: Request, res: Response) => {
    const parsed = ticketLookupRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success || !isTicketAccessCode(parsed.data.ticketCode)) {
      return res.status(404).json({ error: 'TICKET_NOT_FOUND', message: 'Ticket code not found.' });
    }

    try {
      const ticketCode = parsed.data.ticketCode;
      const [bet] = await db.select().from(bets)
        .where(eq(bets.publicTicketCodeHash, hashTicketAccessCode(ticketCode)))
        .limit(1);
      if (!bet) return res.status(404).json({ error: 'TICKET_NOT_FOUND', message: 'Ticket code not found.' });
      const [ticket] = await attachBetTicketDetails([bet]);
      const { stake, totalOdds, potentialPayout, status, placedAt, settledAt, settlement, selections } = ticket;
      return res.json({
        stake,
        totalOdds,
        potentialPayout,
        status,
        placedAt,
        settledAt,
        settlement,
        selections: selections.map(({ outcomeCode, odds, status: selectionStatus, marketType, displayName, fixture }) => ({
          outcomeCode,
          odds,
          status: selectionStatus,
          marketType,
          displayName,
          fixture,
        })),
      });
    } catch (error) {
      console.error('Public ticket lookup failed:', error);
      return res.status(503).json({ error: 'TICKET_LOOKUP_UNAVAILABLE', message: 'Ticket details are temporarily unavailable.' });
    }
  });

  app.get('/api/wallet/solana/config', authenticateJwt, requireLocalAccount, (req: AuthenticatedRequest, res: Response) => {
    try {
      return res.json(getSolanaPaymentConfig());
    } catch (error) {
      return sendSolanaPaymentError(res, error, 'Solana payment configuration lookup');
    }
  });

  app.get('/api/wallet/solana/blockhash', authenticateJwt, requireLocalAccount, solanaPaymentStatusLimiter, async (_req: AuthenticatedRequest, res: Response) => {
    try {
      return res.json({ blockhash: await getSolanaPaymentBlockhash() });
    } catch (error) {
      if (error instanceof SolanaPaymentError) {
        return sendSolanaPaymentError(res, error, 'Solana latest blockhash lookup');
      }
      console.error('Solana latest blockhash lookup failed.', error);
      return res.status(503).json({
        error: 'SOLANA_RPC_UNAVAILABLE',
        message: 'A payment transaction could not be prepared. Try again shortly.',
      });
    }
  });

  app.post('/api/wallet/solana/orders', authenticateJwt, requireLocalAccount, solanaOrderCreateLimiter, async (req: AuthenticatedRequest, res: Response) => {
    const parsed = solanaOrderRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID_PAYMENT_ORDER', message: 'Choose a credit amount and connect a valid Solana wallet.' });
    }
    try {
      const order = await createSolanaPaymentOrder(
        req.user!.id,
        parsed.data.packageId,
        parsed.data.payerAddress,
        parsed.data.idempotencyKey,
        parsed.data.creditAmount,
      );
      return res.status(201).json({ order: publicSolanaOrder(order) });
    } catch (error) {
      return sendSolanaPaymentError(res, error, 'Solana payment order creation');
    }
  });

  app.get('/api/wallet/solana/orders/:orderId', authenticateJwt, requireLocalAccount, solanaPaymentStatusLimiter, async (req: AuthenticatedRequest, res: Response) => {
    const orderId = z.string().uuid().safeParse(req.params.orderId);
    if (!orderId.success) {
      return res.status(400).json({ error: 'INVALID_ORDER_ID', message: 'Choose a valid payment order.' });
    }
    try {
      const order = await getSolanaPaymentOrder(req.user!.id, orderId.data);
      const reconciled = await reconcileSolanaPaymentOrder(order.id);
      return res.json({ order: publicSolanaOrder(reconciled) });
    } catch (error) {
      return sendSolanaPaymentError(res, error, 'Solana payment status lookup');
    }
  });

  app.post('/api/wallet/solana/orders/:orderId/submit', authenticateJwt, requireLocalAccount, solanaPaymentStatusLimiter, async (req: AuthenticatedRequest, res: Response) => {
    const orderId = z.string().uuid().safeParse(req.params.orderId);
    const parsed = solanaSignatureRequestSchema.safeParse(req.body ?? {});
    if (!orderId.success || !parsed.success) {
      return res.status(400).json({ error: 'INVALID_PAYMENT_SUBMISSION', message: 'Submit a valid payment order and transaction signature.' });
    }
    try {
      const submittedOrder = await submitSolanaPaymentSignature(
        req.user!.id,
        orderId.data,
        parsed.data.signature,
      );
      try {
        const order = await reconcileSolanaPaymentOrder(submittedOrder.id, parsed.data.signature);
        return res.status(order.status === 'CREDITED' ? 200 : 202).json({ order: publicSolanaOrder(order) });
      } catch (error) {
        if (error instanceof SolanaPaymentError) return sendSolanaPaymentError(res, error, 'Solana payment verification');
        console.error(`Solana payment verification deferred for order ${submittedOrder.id}:`, error);
        return res.status(503).json({
          error: 'PAYMENT_VERIFICATION_DEFERRED',
          message: 'Your transaction was submitted, but confirmation is temporarily unavailable. We will keep checking it.',
          order: publicSolanaOrder(submittedOrder),
        });
      }
    } catch (error) {
      return sendSolanaPaymentError(res, error, 'Solana payment submission');
    }
  });

  app.get('/api/wallet/solana/wallet', authenticateJwt, requireLocalAccount, async (req: AuthenticatedRequest, res: Response) => {
    const [latestOrder] = await db.select({
      address: solanaPaymentOrders.payerAddress,
      network: solanaPaymentOrders.network,
      connectedAt: solanaPaymentOrders.createdAt,
    }).from(solanaPaymentOrders)
      .where(eq(solanaPaymentOrders.userId, req.user!.id))
      .orderBy(desc(solanaPaymentOrders.createdAt))
      .limit(1);
    return res.json({ wallet: latestOrder ?? null });
  });

  // 6. Wallet API
  app.get('/api/wallet', authenticateJwt, requireLocalAccount, async (req: AuthenticatedRequest, res: Response) => {
    const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, req.user!.id));
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
    res.json(wallet);
  });

  app.get('/api/wallet/transactions', authenticateJwt, requireLocalAccount, async (req: AuthenticatedRequest, res: Response) => {
    const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, req.user!.id));
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    const txs = await db.select({
      id: walletTransactions.id,
      walletId: walletTransactions.walletId,
      type: walletTransactions.type,
      amount: walletTransactions.amount,
      balanceBefore: walletTransactions.balanceBefore,
      balanceAfter: walletTransactions.balanceAfter,
      referenceType: walletTransactions.referenceType,
      referenceId: walletTransactions.referenceId,
      idempotencyKey: walletTransactions.idempotencyKey,
      createdAt: walletTransactions.createdAt,
      transactionSignature: solanaPaymentOrders.transactionSignature,
      paymentNetwork: solanaPaymentOrders.network,
      payerAddress: solanaPaymentOrders.payerAddress,
      paymentUsdCents: solanaPaymentOrders.usdCents,
      paymentLamports: solanaPaymentOrders.expectedLamports,
    }).from(walletTransactions)
      .leftJoin(solanaPaymentOrders, and(
        eq(walletTransactions.referenceType, 'SOLANA_PAYMENT'),
        eq(walletTransactions.referenceId, solanaPaymentOrders.id),
        eq(solanaPaymentOrders.userId, req.user!.id),
      ))
      .where(eq(walletTransactions.walletId, wallet.id))
      .orderBy(desc(walletTransactions.createdAt));
    res.json(txs);
  });

  // 7. Admin Simulation Lab API — Protected strictly for Admin roles
  app.post('/api/admin/simulation-lab/run', authenticateJwt, requireRole(['admin', 'ADMIN', 'SUPER_ADMIN']), async (req: Request, res: Response) => {
    try {
      const { fixtureId, seed, homeTeam, awayTeam } = req.body;

      const engine = new MatchEngine({
        fixtureId: fixtureId || 'sim-lab-fixture-1',
        seasonId: 'sim-lab-season',
        simulationVersion: env.SIMULATION_VERSION,
        seed: seed || 'sim-lab-seed-123',
        homeTeam: homeTeam || { id: 'team-a', name: 'Team A', attackStrength: 1.2, defenseStrength: 1.0, overallRating: 80 },
        awayTeam: awayTeam || { id: 'team-b', name: 'Team B', attackStrength: 1.0, defenseStrength: 1.1, overallRating: 78 },
        homePlayers: [],
        awayPlayers: [],
      });

      const result = engine.simulate();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: 'SIMULATION_LAB_FAILED', message: err.message });
    }
  });

  // Global Error Handler
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.error('❌ Global error caught:', err);
    res.status(err.status || 500).json({ error: err.code || 'INTERNAL_SERVER_ERROR', message: err.message || 'An unexpected error occurred' });
  });

  return app;
}
