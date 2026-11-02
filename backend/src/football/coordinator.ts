import postgres from 'postgres';
import Redis from 'ioredis';
import { db } from '../db/index';
import { worldRuntime, leagues, seasons, teams, fixtures, matches, markets, marketOutcomes, oddsSnapshots, teamRatings, standings } from '../db/schema/index';
import { eq, and, or, sql, asc, desc, inArray } from 'drizzle-orm';
import { env } from '../config/env';
import { simulationQueue } from '../workers/queues';
import { buildSimulationInput } from './match-input';
import {
  calculateAllPreMatchMarkets,
  calculateExpectedGoals,
  CORNER_TOTAL_LINES,
  GOAL_TOTAL_LINES,
} from '../markets/probability-engine';
import { getRoundCutoffAt } from '../betting/round-market-policy';
import { generateDoubleRoundRobin } from './fixture-generator';
import { buildSynchronizedRoundKickoffs } from './round-schedule';

const ADVISORY_LOCK_ID = 88812388;
const NODE_ID = `node-${process.pid}-${Math.random().toString(36).substring(2, 7)}`;
const REQUIRED_MARKET_TYPES = [
  '1X2',
  'DOUBLE_CHANCE',
  'BTTS',
  'CORRECT_SCORE',
  'TOTAL_CARDS',
  ...GOAL_TOTAL_LINES.map((line) => `TOTAL_GOALS_${line}`),
  ...CORNER_TOTAL_LINES.map((line) => `TOTAL_CORNERS_${line}`),
];

type ExistingFixtureMarket = { marketType: string; marketScope: string };

function hasCompleteMarketSet(existingMarkets: ExistingFixtureMarket[]): boolean {
  const marketTypes = new Set(
    existingMarkets.filter((market) => market.marketScope === 'FULL_TIME').map((market) => market.marketType),
  );
  return REQUIRED_MARKET_TYPES.every((marketType) =>
    marketTypes.has(marketType)
    || (marketType === 'TOTAL_CORNERS_9.5' && marketTypes.has('TOTAL_CORNERS')),
  );
}

export type WorldStatusType = 'RUNNING' | 'RECOVERING' | 'WAITING_FOR_SEASON' | 'DEGRADED' | 'STOPPED';

export interface LeagueStatusDetail {
  leagueId: string;
  leagueName: string;
  seasonId: string | null;
  seasonName: string | null;
  currentRound: number;
  totalRounds: number;
  liveFixtures: number;
  completedFixtures: number;
  scheduledFixtures: number;
  nextKickoffAt: string | null;
  status: string;
}

export interface WorldStatusInfo {
  status: WorldStatusType;
  isCoordinatorLeader: boolean;
  coordinatorNodeId: string | null;
  activeSeasonId: string | null;
  activeSeasonName: string | null;
  currentRound: number;
  totalRounds: number;
  liveFixtureCount: number;
  completedFixtureCount: number;
  scheduledFixtureCount: number;
  nextKickoffAt: string | null;
  heartbeatAt: string | null;
  lastReconciliationAt: string | null;
  degradedReason: string | null;
  activeLeagues: LeagueStatusDetail[];
  dependencies: {
    postgres: boolean;
    redis: boolean;
  };
}

export function deriveWorldRound(
  worldFixtures: Array<{ round: number; status: string }>,
  totalRounds: number
): number {
  for (let round = 1; round <= totalRounds; round++) {
    const roundFixtures = worldFixtures.filter((fixture) => fixture.round === round);
    if (roundFixtures.length === 0 || roundFixtures.some((fixture) => fixture.status !== 'FINISHED' && fixture.status !== 'CANCELLED')) {
      return round;
    }
  }
  return totalRounds;
}

export function deriveWorldRoundAfterBreak(
  worldFixtures: Array<{ round: number; status: string; finishedAt?: Date | string | null }>,
  totalRounds: number,
  now: Date,
  roundBreakSeconds: number
): number {
  const candidateRound = deriveWorldRound(worldFixtures, totalRounds);
  if (candidateRound <= 1) return candidateRound;

  const seasonIsFinished = Array.from({ length: totalRounds }, (_, index) => index + 1).every((round) => {
    const fixtures = worldFixtures.filter((fixture) => fixture.round === round);
    return fixtures.length > 0 && fixtures.every((fixture) => fixture.status === 'FINISHED' || fixture.status === 'CANCELLED');
  });
  if (seasonIsFinished) return candidateRound;

  const previousRoundFixtures = worldFixtures.filter((fixture) => fixture.round === candidateRound - 1);
  if (previousRoundFixtures.length === 0 || previousRoundFixtures.some((fixture) => fixture.status !== 'FINISHED' && fixture.status !== 'CANCELLED')) {
    return candidateRound;
  }

  const latestFinish = previousRoundFixtures.reduce((latest: number | null, fixture) => {
    if (!fixture.finishedAt) return latest;
    const finishedAt = new Date(fixture.finishedAt).getTime();
    return Number.isFinite(finishedAt) && (latest === null || finishedAt > latest) ? finishedAt : latest;
  }, null);
  if (latestFinish === null) return candidateRound;

  const nextRoundAt = latestFinish + roundBreakSeconds * 1000;
  return now.getTime() < nextRoundAt ? candidateRound - 1 : candidateRound;
}

export function getRoundKickoffStartAt(latestFinish: Date, now: Date, roundBreakSeconds: number): Date {
  const roundBreakEndsAt = latestFinish.getTime() + roundBreakSeconds * 1000;
  return new Date(Math.max(roundBreakEndsAt, now.getTime()));
}

let dedicatedLockSql: ReturnType<typeof postgres> | null = null;
let isLeader = false;
let loopInterval: NodeJS.Timeout | null = null;
let currentStatus: WorldStatusType = 'WAITING_FOR_SEASON';
let degradedReasonStr: string | null = null;
let lastReconciliationTime: Date | null = null;
let hasSynchronizedExistingSchedule = false;

export async function checkDependenciesHealth(): Promise<{ postgres: boolean; redis: boolean; migrationOk: boolean; error?: string }> {
  let pgOk = false;
  let redisOk = false;
  let migrationOk = false;
  let errorMsg: string | undefined;

  try {
    await db.execute(sql`SELECT 1 FROM world_runtime LIMIT 1`);
    pgOk = true;
    migrationOk = true;
  } catch (err: any) {
    try {
      await db.execute(sql`SELECT 1`);
      pgOk = true;
      migrationOk = false;
      errorMsg = 'Missing database migrations: world_runtime table does not exist. Please run npm run migrate.';
    } catch (_) {
      pgOk = false;
      migrationOk = false;
      errorMsg = 'PostgreSQL database is unavailable.';
    }
  }

  try {
    const redisClient = new Redis(env.REDIS_URL, {
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      tls: env.REDIS_URL.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
    });
    const pong = await redisClient.ping();
    redisOk = (pong === 'PONG');
    redisClient.disconnect();
  } catch (err) {
    redisOk = false;
  }

  return { postgres: pgOk, redis: redisOk, migrationOk, error: errorMsg };
}

export async function tryAcquireCoordinatorLeadership(): Promise<boolean> {
  try {
    if (!dedicatedLockSql) {
      dedicatedLockSql = postgres(env.DATABASE_URL, {
        max: 1,
        connect_timeout: 5,
        ssl: env.DATABASE_URL.includes('sslmode=require') ? 'require' : false,
      });
    }

    const result = await dedicatedLockSql`SELECT pg_try_advisory_lock(${ADVISORY_LOCK_ID}) as locked`;
    const locked = result[0]?.locked === true;

    if (locked && !isLeader) {
      console.log(`👑 [WORLD COORDINATOR] Leadership acquired by node '${NODE_ID}'`);
    }
    isLeader = locked;
    return isLeader;
  } catch (err: any) {
    isLeader = false;
    console.error(`⚠️ [WORLD COORDINATOR] Failed acquiring leadership lock: ${err.message}`);
    return false;
  }
}

export async function releaseCoordinatorLeadership(): Promise<void> {
  if (dedicatedLockSql && isLeader) {
    try {
      await dedicatedLockSql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_ID})`;
      console.log(`👑 [WORLD COORDINATOR] Leadership released by node '${NODE_ID}'`);
    } catch (err: any) {
      console.error(`⚠️ Error unlocking coordinator advisory lock: ${err.message}`);
    }
  }
  isLeader = false;
  if (dedicatedLockSql) {
    try {
      await dedicatedLockSql.end({ timeout: 2 });
    } catch (_) {}
    dedicatedLockSql = null;
  }
}

export async function updateRuntimeHeartbeat(
  status: WorldStatusType,
  activeSeasonId: string | null = null,
  round = 0,
  totalRounds = 38,
  reason: string | null = null
) {
  currentStatus = status;
  degradedReasonStr = reason;

  try {
    await db
      .insert(worldRuntime)
      .values({
        id: 'singleton',
        status,
        activeSeasonId,
        currentRound: round,
        totalRounds,
        coordinatorNodeId: isLeader ? NODE_ID : null,
        heartbeatAt: new Date(),
        lastReconciliationAt: lastReconciliationTime,
        degradedReason: reason,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: worldRuntime.id,
        set: {
          status,
          activeSeasonId,
          currentRound: round,
          totalRounds,
          coordinatorNodeId: isLeader ? NODE_ID : sql`world_runtime.coordinator_node_id`,
          heartbeatAt: new Date(),
          lastReconciliationAt: lastReconciliationTime,
          degradedReason: reason,
          updatedAt: new Date(),
        },
      });
  } catch (err: any) {
    console.error(`⚠️ Failed updating world runtime table: ${err.message}`);
  }
}

/** Creates every competition's next numbered season in one transaction. */
async function createNextWorldSeasons(previousWorldSeasons: Array<{ league: any; season: any }>) {
  const nextSeasonNumber = Math.max(...previousWorldSeasons.map(({ season }) => season.seasonNumber)) + 1;
  const now = new Date();
  const firstKickoff = new Date(now.getTime() + env.MARKET_PREPARATION_BUFFER_SECONDS * 1000);

  return db.transaction(async (tx) => {
    const createdSeasons = [];

    for (const { league, season: previousSeason } of previousWorldSeasons) {
      const leagueTeams = await tx.select().from(teams)
        .where(and(eq(teams.leagueId, league.id), eq(teams.active, true)))
        .orderBy(asc(teams.slug));
      if (leagueTeams.length === 0 || leagueTeams.length % 2 !== 0) {
        throw new Error(`Cannot create Season ${nextSeasonNumber} for ${league.name}: configured clubs are missing or have an odd team count.`);
      }

      const totalRounds = (leagueTeams.length - 1) * 2;
      const [newSeason] = await tx.insert(seasons).values({
        leagueId: league.id,
        name: `Season ${nextSeasonNumber}`,
        seasonNumber: nextSeasonNumber,
        status: 'ACTIVE',
        startAt: now,
        currentRound: 1,
        totalRounds,
      }).returning();
      createdSeasons.push(newSeason);

      for (const team of leagueTeams) {
        const [previousRating] = await tx.select().from(teamRatings).where(
          and(eq(teamRatings.seasonId, previousSeason.id), eq(teamRatings.teamId, team.id))
        );
        if (!previousRating) throw new Error(`Missing prior-season rating for ${team.name} in ${league.name}.`);

        await tx.insert(standings).values({ seasonId: newSeason.id, teamId: team.id });
        await tx.insert(teamRatings).values({
          teamId: team.id,
          seasonId: newSeason.id,
          overallAbility: previousRating.overallAbility,
          attackStrength: previousRating.attackStrength,
          defenseStrength: previousRating.defenseStrength,
          creationRating: previousRating.creationRating,
          finishingRating: previousRating.finishingRating,
          goalkeepingRating: previousRating.goalkeepingRating,
          pressingRating: previousRating.pressingRating,
          disciplineRating: previousRating.disciplineRating,
          homeAdvantage: previousRating.homeAdvantage,
        });
      }

      const pairings = generateDoubleRoundRobin(leagueTeams.length);
      const roundKickoffs = buildSynchronizedRoundKickoffs(
        firstKickoff,
        totalRounds,
        env.MATCH_REAL_DURATION_SECONDS,
        env.ROUND_BREAK_SECONDS,
      );
      const fixturesToInsert = pairings.map((pairing) => {
        return {
          seasonId: newSeason.id,
          round: pairing.round,
          homeTeamId: leagueTeams[pairing.homeTeamIndex].id,
          awayTeamId: leagueTeams[pairing.awayTeamIndex].id,
          scheduledAt: roundKickoffs[pairing.round - 1],
          status: 'SCHEDULED',
        };
      });

      for (let i = 0; i < fixturesToInsert.length; i += 100) {
        await tx.insert(fixtures).values(fixturesToInsert.slice(i, i + 100));
      }
    }

    console.log(`🌍 [WORLD COORDINATOR] Created Season ${nextSeasonNumber} for ${createdSeasons.length} competitions in one transaction.`);
    return createdSeasons;
  });
}

/**
 * Main coordinator loop tick.
 */
export async function tickCoordinator(): Promise<void> {
  const health = await checkDependenciesHealth();

  if (!health.postgres || !health.migrationOk) {
    currentStatus = 'DEGRADED';
    degradedReasonStr = health.error || 'PostgreSQL database is unavailable or missing migrations.';
    console.error(`❌ [WORLD COORDINATOR] DEGRADED: ${degradedReasonStr}`);
    return;
  }

  await tryAcquireCoordinatorLeadership();

  if (!isLeader) {
    return;
  }

  if (!health.redis) {
    currentStatus = 'DEGRADED';
    degradedReasonStr = 'Redis is unavailable.';
    console.warn(`⚠️ [WORLD COORDINATOR] DEGRADED: ${degradedReasonStr}`);
    await updateRuntimeHeartbeat('DEGRADED', null, 0, 38, degradedReasonStr);
    return;
  }

  try {
    await reconcileAndScheduleWorld();
  } catch (err: any) {
    console.error(`❌ [WORLD COORDINATOR] Error in reconciliation loop:`, err);
    currentStatus = 'DEGRADED';
    degradedReasonStr = err.message;
    await updateRuntimeHeartbeat('DEGRADED', null, 0, 38, degradedReasonStr);
  }
}

async function synchronizeExistingWorldSchedule(
  worldFixtures: Array<typeof fixtures.$inferSelect>,
  currentRound: number,
  totalRounds: number,
  now: Date,
): Promise<number> {
  const roundFixtures = worldFixtures.filter((fixture) => fixture.round === currentRound);
  if (roundFixtures.length === 0) return 0;

  const startedFixtures = roundFixtures.filter((fixture) => fixture.startedAt !== null);
  const scheduledFixtures = roundFixtures.filter((fixture) => fixture.status === 'SCHEDULED');
  const firstScheduledKickoff = scheduledFixtures.reduce(
    (earliest: Date | null, fixture) => !earliest || fixture.scheduledAt < earliest ? fixture.scheduledAt : earliest,
    null,
  );
  const currentRoundKickoff = startedFixtures.length > 0
    ? now
    : firstScheduledKickoff;

  let changedRounds = 0;
  if (currentRoundKickoff && scheduledFixtures.some(
    (fixture) => fixture.scheduledAt.getTime() !== currentRoundKickoff.getTime(),
  )) {
    await db.update(fixtures)
      .set({ scheduledAt: currentRoundKickoff, updatedAt: now })
      .where(inArray(fixtures.id, scheduledFixtures.map((fixture) => fixture.id)));
    for (const fixture of scheduledFixtures) fixture.scheduledAt = currentRoundKickoff;
    changedRounds++;
  }

  let latestProjectedFinish: Date | null = null;
  const matchDurationMs = env.MATCH_REAL_DURATION_SECONDS * 1000;
  for (const fixture of roundFixtures) {
    if (fixture.status === 'CANCELLED') continue;

    let projectedFinish: Date | null = null;
    if (fixture.status === 'FINISHED' && fixture.finishedAt) {
      projectedFinish = fixture.finishedAt;
    } else if (fixture.startedAt) {
      projectedFinish = new Date(Math.max(now.getTime(), fixture.startedAt.getTime() + matchDurationMs));
    } else if (fixture.status === 'SCHEDULED') {
      projectedFinish = new Date(fixture.scheduledAt.getTime() + matchDurationMs);
    }

    if (projectedFinish && (!latestProjectedFinish || projectedFinish > latestProjectedFinish)) {
      latestProjectedFinish = projectedFinish;
    }
  }

  if (!latestProjectedFinish || currentRound >= totalRounds) return changedRounds;

  const firstUpcomingKickoff = new Date(Math.max(
    now.getTime(),
    latestProjectedFinish.getTime() + env.ROUND_BREAK_SECONDS * 1000,
  ));
  const upcomingRoundKickoffs = buildSynchronizedRoundKickoffs(
    firstUpcomingKickoff,
    totalRounds - currentRound,
    env.MATCH_REAL_DURATION_SECONDS,
    env.ROUND_BREAK_SECONDS,
  );

  for (let round = currentRound + 1; round <= totalRounds; round++) {
    const kickoff = upcomingRoundKickoffs[round - currentRound - 1];
    const scheduledRoundFixtures = worldFixtures.filter(
      (fixture) => fixture.round === round && fixture.status === 'SCHEDULED',
    );
    if (scheduledRoundFixtures.length === 0 || !kickoff) continue;
    if (!scheduledRoundFixtures.some((fixture) => fixture.scheduledAt.getTime() !== kickoff.getTime())) continue;

    await db.update(fixtures)
      .set({ scheduledAt: kickoff, updatedAt: now })
      .where(inArray(fixtures.id, scheduledRoundFixtures.map((fixture) => fixture.id)));
    for (const fixture of scheduledRoundFixtures) fixture.scheduledAt = kickoff;
    changedRounds++;
  }

  return changedRounds;
}

export async function reconcileAndScheduleWorld(): Promise<void> {
  const now = new Date();
  lastReconciliationTime = now;

  const allLeagues = await db.select().from(leagues).where(eq(leagues.active, true)).orderBy(asc(leagues.slug));

  if (allLeagues.length === 0) {
    currentStatus = 'WAITING_FOR_SEASON';
    degradedReasonStr = 'No active leagues found in PostgreSQL.';
    await updateRuntimeHeartbeat('WAITING_FOR_SEASON', null, 0, 38, degradedReasonStr);
    return;
  }

  const worldSeasons: Array<{ league: any; season: any }> = [];
  for (const league of allLeagues) {
    const [activeSeason] = await db
      .select()
      .from(seasons)
      .where(and(eq(seasons.leagueId, league.id), eq(seasons.status, 'ACTIVE')))
      .limit(1);

    const [scheduledSeason] = activeSeason ? [] : await db
        .select()
        .from(seasons)
        .where(and(eq(seasons.leagueId, league.id), eq(seasons.status, 'SCHEDULED')))
    const season = activeSeason || scheduledSeason;
    if (season) worldSeasons.push({ league, season });
  }

  if (worldSeasons.length !== allLeagues.length) {
    if (worldSeasons.length === 0) {
      const completedWorld: Array<{ league: any; season: any }> = [];
      for (const league of allLeagues) {
        const [completedSeason] = await db.select().from(seasons)
          .where(and(eq(seasons.leagueId, league.id), eq(seasons.status, 'COMPLETED')))
          .orderBy(desc(seasons.seasonNumber)).limit(1);
        if (!completedSeason) break;
        completedWorld.push({ league, season: completedSeason });
      }
      if (completedWorld.length === allLeagues.length && new Set(completedWorld.map(({ season }) => season.seasonNumber)).size === 1) {
        const created = await createNextWorldSeasons(completedWorld);
        worldSeasons.push(...allLeagues.map((league, index) => ({ league, season: created[index] })));
      }
    }
  }

  if (worldSeasons.length !== allLeagues.length) {
    currentStatus = 'WAITING_FOR_SEASON';
    degradedReasonStr = 'A complete matching season is required for every active competition.';
    await updateRuntimeHeartbeat('WAITING_FOR_SEASON', null, 0, 38, degradedReasonStr);
    return;
  }

  const seasonNumbers = new Set(worldSeasons.map(({ season }) => season.seasonNumber));
  const totalRoundCounts = new Set(worldSeasons.map(({ season }) => season.totalRounds));
  if (seasonNumbers.size !== 1 || totalRoundCounts.size !== 1) {
    currentStatus = 'DEGRADED';
    degradedReasonStr = 'Active competitions do not share the same season number and round count.';
    await updateRuntimeHeartbeat('DEGRADED', null, 0, 38, degradedReasonStr);
    return;
  }

  const seasonIds = worldSeasons.map(({ season }) => season.id);
  const firstSeason = worldSeasons[0].season;
  const totalRounds = firstSeason.totalRounds;
  const allFixtures = await db.select().from(fixtures)
    .where(inArray(fixtures.seasonId, seasonIds))
    .orderBy(asc(fixtures.scheduledAt), asc(fixtures.id));
  const [runtimeRow] = await db.select().from(worldRuntime).where(eq(worldRuntime.id, 'singleton'));
  const fixtureDerivedRound = deriveWorldRound(allFixtures, totalRounds);
  let worldRound = deriveWorldRoundAfterBreak(allFixtures, totalRounds, now, env.ROUND_BREAK_SECONDS);

  if (!hasSynchronizedExistingSchedule) {
    const changedRounds = await synchronizeExistingWorldSchedule(allFixtures, worldRound, totalRounds, now);
    hasSynchronizedExistingSchedule = true;
    if (changedRounds > 0) {
      console.log(`⚽ [WORLD COORDINATOR] Synchronized scheduled fixtures across ${changedRounds} world rounds.`);
    }
  }

  if (worldRound === fixtureDerivedRound && worldRound > 1) {
    const previousRoundFixtures = allFixtures.filter((fixture) => fixture.round === worldRound - 1);
    const previousRoundIsComplete = previousRoundFixtures.length > 0
      && previousRoundFixtures.every((fixture) => fixture.status === 'FINISHED' || fixture.status === 'CANCELLED');
    const latestFinish = previousRoundFixtures.reduce((latest: Date | null, fixture) => {
      if (!fixture.finishedAt) return latest;
      return !latest || fixture.finishedAt > latest ? fixture.finishedAt : latest;
    }, null);

    if (previousRoundIsComplete && latestFinish) {
      const nextRoundAt = getRoundKickoffStartAt(latestFinish, now, env.ROUND_BREAK_SECONDS);
      const nextRoundFixtures = allFixtures.filter((fixture) => fixture.round === worldRound);
      let staleKickoffsCorrected = 0;

      for (const fixture of nextRoundFixtures) {
        const expectedKickoff = nextRoundAt;
        if (fixture.status === 'SCHEDULED' && fixture.scheduledAt > expectedKickoff) {
          await db.update(fixtures).set({ scheduledAt: expectedKickoff, updatedAt: now }).where(eq(fixtures.id, fixture.id));
          fixture.scheduledAt = expectedKickoff;
          staleKickoffsCorrected++;
        }
      }

      if (staleKickoffsCorrected > 0) {
        console.warn(`⚠️ [WORLD COORDINATOR] Corrected ${staleKickoffsCorrected} stale kickoff times for Round ${worldRound}; the round break ends at ${nextRoundAt.toISOString()}.`);
      }
    }
  }

  if (runtimeRow && runtimeRow.currentRound !== worldRound) {
    console.warn(`⚠️ [WORLD COORDINATOR] Correcting persisted round ${runtimeRow.currentRound} to the ready shared round ${worldRound}.`);
  }

  for (const { league, season } of worldSeasons) {
    const virtualSeasonName = `Season ${season.seasonNumber}`;
    if (season.status === 'SCHEDULED' || season.currentRound !== worldRound || season.name !== virtualSeasonName) {
      await db.update(seasons).set({
        name: virtualSeasonName,
        status: 'ACTIVE',
        startAt: season.startAt || now,
        currentRound: worldRound,
      }).where(eq(seasons.id, season.id));
      season.status = 'ACTIVE';
      season.currentRound = worldRound;
      if (season.status === 'SCHEDULED') console.log(`⚽ [WORLD COORDINATOR] Activated ${season.name} for ${league.name}`);
    }
  }

  const roundFixtures = allFixtures.filter((fixture) => fixture.round === worldRound);

  if (roundFixtures.length === 0) {
    currentStatus = 'DEGRADED';
    degradedReasonStr = `No fixtures exist for shared world round ${worldRound}.`;
    await updateRuntimeHeartbeat('DEGRADED', firstSeason.id, worldRound, totalRounds, degradedReasonStr);
    return;
  }

  const uncompletedFixtures = roundFixtures.filter((fixture) => fixture.status !== 'FINISHED' && fixture.status !== 'CANCELLED');
  if (uncompletedFixtures.length === 0) {
    const latestFinish = roundFixtures.reduce((latest: Date | null, fixture) => {
      if (!fixture.finishedAt) return latest;
      return !latest || fixture.finishedAt > latest ? fixture.finishedAt : latest;
    }, null);
    const nextRoundAt = new Date((latestFinish || now).getTime() + env.ROUND_BREAK_SECONDS * 1000);

    if (now >= nextRoundAt) {
      if (worldRound < totalRounds) {
        const nextRound = worldRound + 1;
        const nextFixtures = allFixtures.filter((fixture) => fixture.round === nextRound && fixture.status === 'SCHEDULED');
        for (const fixture of nextFixtures) {
          const scheduledAt = nextRoundAt;
          await db.update(fixtures).set({ scheduledAt, updatedAt: now }).where(eq(fixtures.id, fixture.id));
          fixture.scheduledAt = scheduledAt;
        }
        await db.transaction(async (tx) => {
          await tx.update(seasons).set({ currentRound: nextRound }).where(inArray(seasons.id, seasonIds));
          await tx.insert(worldRuntime).values({
            id: 'singleton', status: 'RUNNING', activeSeasonId: firstSeason.id,
            currentRound: nextRound, totalRounds, heartbeatAt: now,
            lastReconciliationAt: now, coordinatorNodeId: NODE_ID, updatedAt: now,
          }).onConflictDoUpdate({
            target: worldRuntime.id,
            set: { status: 'RUNNING', activeSeasonId: firstSeason.id, currentRound: nextRound, totalRounds,
              heartbeatAt: now, lastReconciliationAt: now, coordinatorNodeId: NODE_ID, degradedReason: null, updatedAt: now },
          });
        });
        worldRound = nextRound;
        console.log(`🌍 [WORLD COORDINATOR] Shared Round ${nextRound - 1} completed across ${allLeagues.length} competitions; Round ${nextRound} begins at ${nextRoundAt.toISOString()}.`);
      } else {
        const previousWorldSeasons = worldSeasons;
        await db.update(seasons).set({ status: 'COMPLETED', endAt: now }).where(inArray(seasons.id, seasonIds));
        await createNextWorldSeasons(previousWorldSeasons);
        currentStatus = 'RECOVERING';
        await updateRuntimeHeartbeat('RECOVERING', null, 0, totalRounds, 'Created the next numbered world season.');
        return;
      }
    } else if (worldRound < totalRounds && latestFinish) {
      const marketPreparationStartsAt = nextRoundAt.getTime() - env.MARKET_PREPARATION_BUFFER_SECONDS * 1000;
      if (now.getTime() >= marketPreparationStartsAt) {
        const nextRoundFixtures = allFixtures.filter((fixture) => fixture.round === worldRound + 1 && fixture.status === 'SCHEDULED');
        for (const fixture of nextRoundFixtures) {
          const existingMarkets = await db.select({
            marketType: markets.marketType,
            marketScope: markets.marketScope,
          }).from(markets).where(eq(markets.fixtureId, fixture.id));
          if (!hasCompleteMarketSet(existingMarkets)) {
            await prepareFixtureMarkets(fixture.id, fixture.seasonId, fixture.homeTeamId, fixture.awayTeamId, existingMarkets);
          }
        }
      }
    }
  }

  const currentRoundFixtures = allFixtures.filter((fixture) => fixture.round === worldRound);
  const marketOpenAt = env.MARKET_PREPARATION_BUFFER_SECONDS * 1000;
  const roundCutoffAt = getRoundCutoffAt(
    currentRoundFixtures
      .filter((fixture) => fixture.status !== 'CANCELLED' && fixture.status !== 'POSTPONED')
      .map((fixture) => fixture.scheduledAt),
  );
  const roundFixtureIds = currentRoundFixtures.map((fixture) => fixture.id);
  const marketPreparationDeadline = currentRoundFixtures
    .filter((fixture) => fixture.status !== 'CANCELLED' && fixture.status !== 'POSTPONED')
    .reduce((earliest: Date | null, fixture) => !earliest || fixture.scheduledAt < earliest ? fixture.scheduledAt : earliest, null);

  if (marketPreparationDeadline && marketPreparationDeadline.getTime() - now.getTime() <= marketOpenAt) {
    const scheduledFixtures = currentRoundFixtures.filter((fixture) => fixture.status === 'SCHEDULED');
    for (const fixture of scheduledFixtures) {
      const existingMarkets = await db.select({
        marketType: markets.marketType,
        marketScope: markets.marketScope,
      }).from(markets).where(eq(markets.fixtureId, fixture.id));
      if (!hasCompleteMarketSet(existingMarkets)) {
        await prepareFixtureMarkets(fixture.id, fixture.seasonId, fixture.homeTeamId, fixture.awayTeamId, existingMarkets);
      }
    }
  }

  if (roundCutoffAt && now >= roundCutoffAt && roundFixtureIds.length > 0) {
    await db.update(markets)
      .set({ status: 'SUSPENDED', updatedAt: now })
      .where(and(inArray(markets.fixtureId, roundFixtureIds), eq(markets.status, 'OPEN')));
  }

  const roundHasStarted = currentRoundFixtures.some((fixture) =>
    fixture.status === 'LIVE'
    || fixture.status === 'HALFTIME'
    || fixture.status === 'SECOND_HALF'
    || fixture.status === 'FINISHED'
    || (fixture.status === 'SCHEDULED' && fixture.scheduledAt <= now),
  );
  if (roundHasStarted && worldRound < totalRounds) {
    const upcomingFixtures = allFixtures.filter((fixture) =>
      fixture.round === worldRound + 1 && fixture.status === 'SCHEDULED',
    );
    const upcomingFixtureIds = upcomingFixtures.map((fixture) => fixture.id);
    const existingUpcomingMarkets = upcomingFixtureIds.length === 0
      ? []
      : await db.select({
        fixtureId: markets.fixtureId,
        marketType: markets.marketType,
        marketScope: markets.marketScope,
      })
        .from(markets)
        .where(inArray(markets.fixtureId, upcomingFixtureIds));
    const marketsByFixtureId = new Map<string, ExistingFixtureMarket[]>();
    for (const market of existingUpcomingMarkets) {
      const fixtureMarkets = marketsByFixtureId.get(market.fixtureId) ?? [];
      fixtureMarkets.push(market);
      marketsByFixtureId.set(market.fixtureId, fixtureMarkets);
    }

    for (const fixture of upcomingFixtures) {
      const existingMarkets = marketsByFixtureId.get(fixture.id) ?? [];
      if (!hasCompleteMarketSet(existingMarkets)) {
        await prepareFixtureMarkets(fixture.id, fixture.seasonId, fixture.homeTeamId, fixture.awayTeamId, existingMarkets);
      }
    }

    const upcomingCutoffAt = getRoundCutoffAt(upcomingFixtures.map((fixture) => fixture.scheduledAt));
    if (upcomingCutoffAt && now < upcomingCutoffAt && upcomingFixtureIds.length > 0) {
      await db.update(markets)
        .set({ status: 'OPEN', updatedAt: now })
        .where(and(
          inArray(markets.fixtureId, upcomingFixtureIds),
          inArray(markets.status, ['SUSPENDED', 'CLOSED']),
        ));
    }
  }

  for (const fixture of currentRoundFixtures) {
    if (fixture.status === 'SCHEDULED') {
      if (fixture.scheduledAt <= now) {
        await db.update(markets).set({ status: 'CLOSED', updatedAt: now }).where(eq(markets.fixtureId, fixture.id));
        await triggerOrCatchUpMatch(fixture);
      }
    } else if (fixture.status === 'LIVE') {
      await triggerOrCatchUpMatch(fixture);
    }
  }

  currentStatus = 'RUNNING';
  degradedReasonStr = null;
  await updateRuntimeHeartbeat('RUNNING', firstSeason.id, worldRound, totalRounds, null);
}

async function prepareFixtureMarkets(
  fixtureId: string,
  seasonId: string,
  homeTeamId: string,
  awayTeamId: string,
  existingMarkets: ExistingFixtureMarket[],
) {
  const [homeRating] = await db.select().from(teamRatings).where(and(eq(teamRatings.seasonId, seasonId), eq(teamRatings.teamId, homeTeamId)));
  const [awayRating] = await db.select().from(teamRatings).where(and(eq(teamRatings.seasonId, seasonId), eq(teamRatings.teamId, awayTeamId)));

  const defaultExpectedGoals = calculateExpectedGoals(
    { attackStrength: 1, defenseStrength: 1 },
    { attackStrength: 1, defenseStrength: 1 },
  );
  let lambdaHome = defaultExpectedGoals.lambdaHome;
  let lambdaAway = defaultExpectedGoals.lambdaAway;

  if (homeRating && awayRating) {
    const expectedGoals = calculateExpectedGoals({
      attackStrength: Number(homeRating.attackStrength),
      defenseStrength: Number(homeRating.defenseStrength),
      homeAdvantage: Number(homeRating.homeAdvantage),
    }, {
      attackStrength: Number(awayRating.attackStrength),
      defenseStrength: Number(awayRating.defenseStrength),
    });
    lambdaHome = expectedGoals.lambdaHome;
    lambdaAway = expectedGoals.lambdaAway;
  }

  const calculated = calculateAllPreMatchMarkets(lambdaHome, lambdaAway);
  const existingMarketTypes = new Set(
    existingMarkets.filter((market) => market.marketScope === 'FULL_TIME').map((market) => market.marketType),
  );

  for (const mData of calculated) {
    if (existingMarketTypes.has(mData.marketType)
      || (mData.marketType === 'TOTAL_CORNERS_9.5' && existingMarketTypes.has('TOTAL_CORNERS'))) {
      continue;
    }

    const [mRecord] = await db.insert(markets).values({
      fixtureId,
      marketType: mData.marketType,
      status: 'OPEN',
    }).returning();

    const outcomesToInsert = mData.outcomes.map((o) => ({
      marketId: mRecord.id,
      outcomeCode: o.outcomeCode,
      displayName: o.displayName,
      probability: o.probability.toFixed(4),
      odds: o.odds.toFixed(2),
      status: 'OPEN',
    }));

    const insertedOutcomes = await db.insert(marketOutcomes).values(outcomesToInsert).returning();
    await db.insert(oddsSnapshots).values(insertedOutcomes.map((outcome) => ({
      marketId: outcome.marketId,
      outcomeCode: outcome.outcomeCode,
      odds: outcome.odds,
      virtualSecond: 0,
    })));
  }
}

async function triggerOrCatchUpMatch(fixture: any) {
  const jobId = `simulation-${fixture.id}`;
  const existingJob = await simulationQueue.getJob(jobId);

  let shouldEnqueue = false;

  if (!existingJob) {
    shouldEnqueue = true;
  } else {
    const jobState = await existingJob.getState();
    if (jobState === 'failed' || jobState === 'completed') {
      if (fixture.status === 'LIVE' || fixture.status === 'SCHEDULED') {
        try {
          await existingJob.remove();
        } catch (_) {}
        shouldEnqueue = true;
      }
    }
  }

  if (shouldEnqueue) {
    try {
      const input = await buildSimulationInput(fixture.id);
      const isOverdue = fixture.scheduledAt && (new Date().getTime() - new Date(fixture.scheduledAt).getTime() > env.MATCH_REAL_DURATION_SECONDS * 1000);
      await simulationQueue.add(
        'simulate-fixture',
        {
          fixtureId: fixture.id,
          input,
          fastMode: isOverdue ? true : false,
          tickDelayMs: 0,
        },
        { jobId }
      );
      console.log(`🚀 [WORLD COORDINATOR] Scheduled match simulation job '${jobId}' for fixture '${fixture.id}' (fastMode=${isOverdue ? 'true' : 'false'})`);
    } catch (err: any) {
      console.error(`⚠️ Failed to build match input or queue job for fixture ${fixture.id}:`, err.message);
    }
  }
}

export async function getWorldStatusInfo(): Promise<WorldStatusInfo> {
  const health = await checkDependenciesHealth();

  let activeSeasonObj = null;
  let liveCount = 0;
  let completedCount = 0;
  let scheduledCount = 0;
  let nextKickoffStr: string | null = null;

  const activeLeaguesDetail: LeagueStatusDetail[] = [];

  if (health.postgres) {
    try {
      const [runtimeRow] = await db.select().from(worldRuntime).where(eq(worldRuntime.id, 'singleton'));
      if (runtimeRow) {
        currentStatus = (runtimeRow.status as WorldStatusType) || currentStatus;
        degradedReasonStr = runtimeRow.degradedReason || null;
      }

      const allLeagues = await db.select().from(leagues).where(eq(leagues.active, true));

      for (const league of allLeagues) {
        const [activeSeason] = await db
          .select()
          .from(seasons)
          .where(and(eq(seasons.leagueId, league.id), eq(seasons.status, 'ACTIVE')))
          .limit(1);

        let lLive = 0;
        let lCompleted = 0;
        let lScheduled = 0;
        let lNextKickoff: string | null = null;

        if (activeSeason) {
          if (!activeSeasonObj) activeSeasonObj = activeSeason;

          const leagueFixtures = await db.select().from(fixtures).where(eq(fixtures.seasonId, activeSeason.id));
          for (const f of leagueFixtures) {
            if (f.status === 'LIVE') {
              lLive++;
              liveCount++;
            } else if (f.status === 'FINISHED') {
              lCompleted++;
              completedCount++;
            } else if (f.status === 'SCHEDULED') {
              lScheduled++;
              scheduledCount++;
              const kStr = f.scheduledAt.toISOString();
              if (!lNextKickoff || kStr < lNextKickoff) lNextKickoff = kStr;
              if (!nextKickoffStr || kStr < nextKickoffStr) nextKickoffStr = kStr;
            }
          }
        }

        activeLeaguesDetail.push({
          leagueId: league.id,
          leagueName: league.name,
          seasonId: activeSeason ? activeSeason.id : null,
          seasonName: activeSeason ? activeSeason.name : null,
          currentRound: activeSeason ? activeSeason.currentRound : 0,
          totalRounds: activeSeason ? activeSeason.totalRounds : 38,
          liveFixtures: lLive,
          completedFixtures: lCompleted,
          scheduledFixtures: lScheduled,
          nextKickoffAt: lNextKickoff,
          status: activeSeason ? 'RUNNING' : 'WAITING_FOR_SEASON',
        });
      }
    } catch (_) {}
  } else {
    currentStatus = 'DEGRADED';
    degradedReasonStr = 'PostgreSQL database is unavailable.';
  }

  return {
    status: currentStatus,
    isCoordinatorLeader: isLeader,
    coordinatorNodeId: isLeader ? NODE_ID : null,
    activeSeasonId: activeSeasonObj ? activeSeasonObj.id : null,
    activeSeasonName: activeSeasonObj ? activeSeasonObj.name : null,
    currentRound: activeSeasonObj ? activeSeasonObj.currentRound : 0,
    totalRounds: activeSeasonObj ? activeSeasonObj.totalRounds : 38,
    liveFixtureCount: liveCount,
    completedFixtureCount: completedCount,
    scheduledFixtureCount: scheduledCount,
    nextKickoffAt: nextKickoffStr,
    heartbeatAt: new Date().toISOString(),
    lastReconciliationAt: lastReconciliationTime ? lastReconciliationTime.toISOString() : null,
    degradedReason: degradedReasonStr,
    activeLeagues: activeLeaguesDetail,
    dependencies: health,
  };
}

export function startCoordinatorLoop(intervalMs = 5000): void {
  if (loopInterval) return;
  console.log(`🏁 [WORLD COORDINATOR] Starting coordinator loop (${intervalMs}ms interval)...`);
  void tickCoordinator();
  loopInterval = setInterval(() => {
    void tickCoordinator();
  }, intervalMs);
}

export async function stopCoordinatorLoop(): Promise<void> {
  if (loopInterval) {
    clearInterval(loopInterval);
    loopInterval = null;
  }
  await releaseCoordinatorLeadership();
}
