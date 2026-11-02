import { verifySafeDatabase } from '../db/guard';
import { db, client } from '../db/index';
import { leagues, seasons, teams, teamRatings, players, fixtures, standings, users, wallets } from '../db/schema/index';
import { COMPETITIONS_DATA_BY_SEASON, SeedCompetition } from './data/competitions';
import { generateDoubleRoundRobin } from './fixture-generator';
import { buildSynchronizedRoundKickoffs } from './round-schedule';
import { eq, and } from 'drizzle-orm';
import { env } from '../config/env';

export function parseVirtualSeasonName(args: string[] = process.argv.slice(2)): string {
  const combined = args.filter(Boolean).join(' ').trim();
  const raw = combined || 'Season 1';

  const normalized = raw.replace(/\s+/g, ' ').trim();
  const match = /^Season\s*(\d+)$/i.exec(normalized);
  if (match) {
    return `Season ${match[1]}`;
  }

  if (/^\d+$/.test(normalized)) {
    return `Season ${normalized}`;
  }

  if (/^Season\s+\d+\s+\d+$/i.test(normalized)) {
    const fallback = normalized.split(/\s+/).filter(Boolean).at(-1);
    if (fallback) return `Season ${fallback}`;
  }

  throw new Error(`Season name must use the virtual format 'Season N'; received '${normalized}'.`);
}

export function resolveCompetitionDataset(targetSeasonName: string): Record<string, SeedCompetition> {
  const directMatch = COMPETITIONS_DATA_BY_SEASON[targetSeasonName];
  if (directMatch) return directMatch;

  const seasonMatch = /^Season\s+(\d+)$/i.exec(targetSeasonName);
  if (seasonMatch) {
    const seasonNumber = Number(seasonMatch[1]);
    const seasonKeys = Object.keys(COMPETITIONS_DATA_BY_SEASON).sort();
    const datasetKey = seasonKeys[(seasonNumber - 1) % seasonKeys.length] ?? seasonKeys[0];
    return COMPETITIONS_DATA_BY_SEASON[datasetKey];
  }

  return COMPETITIONS_DATA_BY_SEASON['2025-2026'];
}

export async function seedDatabase(targetSeasonName: string = 'Season 1') {
  verifySafeDatabase(`Seed Database for Season ${targetSeasonName}`);

  const seasonMatch = /^Season\s+(\d+)$/i.exec(targetSeasonName);
  if (!seasonMatch) throw new Error(`Season name must use the virtual format 'Season N'; received '${targetSeasonName}'.`);

  const seasonNumber = Number(seasonMatch[1]);
  const seasonCompetitions = resolveCompetitionDataset(targetSeasonName);
  const firstKickoffBase = new Date(Date.now() + env.MARKET_PREPARATION_BUFFER_SECONDS * 1000);

  console.log(`🌱 Starting database seed for season '${targetSeasonName}'...`);

  // Ensure default system user and play-money wallet exist
  let [systemUser] = await db.select().from(users).where(eq(users.email, 'demo@simsoccer.com'));
  if (!systemUser) {
    [systemUser] = await db.insert(users).values({
      email: 'demo@simsoccer.com',
      role: 'ADMIN',
    }).returning();

    await db.insert(wallets).values({
      userId: systemUser.id,
      currency: 'VIRTUAL',
      balance: '3000.00',
    });
    console.log('👤 Created demo user demo@simsoccer.com with 3,000 virtual credits wallet.');
  }

  for (const [leagueSlug, compData] of Object.entries(seasonCompetitions)) {
    console.log(`\n🏆 Processing League: ${compData.leagueName} (${compData.country}) — ${targetSeasonName}...`);
    console.log(`   Source: ${compData.provenance.source} (${compData.provenance.sourceUrl})`);

    // 1. Get or create league
    let [leagueRecord] = await db.select().from(leagues).where(eq(leagues.slug, compData.slug));
    if (!leagueRecord) {
      [leagueRecord] = await db.insert(leagues).values({
        name: compData.leagueName,
        slug: compData.slug,
        country: compData.country,
        teamCount: compData.teams.length,
      }).returning();
    }

    // 2. Get or create season
    let [seasonRecord] = await db.select().from(seasons).where(
      and(eq(seasons.leagueId, leagueRecord.id), eq(seasons.name, targetSeasonName))
    );

    if (!seasonRecord) {
      [seasonRecord] = await db.insert(seasons).values({
        leagueId: leagueRecord.id,
        name: targetSeasonName,
        seasonNumber,
        status: 'SCHEDULED',
        totalRounds: 38,
      }).returning();
    }

    // 3. Process 20 Teams, Ratings, Standings and Players in Batch
    const createdTeamIds: string[] = [];

    for (const teamData of compData.teams) {
      let [teamRecord] = await db.select().from(teams).where(eq(teams.slug, teamData.slug));
      if (!teamRecord) {
        [teamRecord] = await db.insert(teams).values({
          leagueId: leagueRecord.id,
          name: teamData.name,
          shortName: teamData.shortName,
          slug: teamData.slug,
          stadiumName: teamData.stadiumName,
        }).returning();
      }
      createdTeamIds.push(teamRecord.id);

      // Upsert Team Rating
      let [ratingRecord] = await db.select().from(teamRatings).where(
        and(eq(teamRatings.teamId, teamRecord.id), eq(teamRatings.seasonId, seasonRecord.id))
      );
      if (!ratingRecord) {
        await db.insert(teamRatings).values({
          teamId: teamRecord.id,
          seasonId: seasonRecord.id,
          overallAbility: teamData.overallRating.toFixed(1),
          attackStrength: teamData.attackStrength.toFixed(2),
          defenseStrength: teamData.defenseStrength.toFixed(2),
          creationRating: '1.00',
          finishingRating: '1.00',
          goalkeepingRating: '1.00',
          pressingRating: '1.00',
          disciplineRating: '1.00',
          homeAdvantage: '1.10',
        });
      }

      // Upsert Initial Standings
      let [standingRecord] = await db.select().from(standings).where(
        and(eq(standings.seasonId, seasonRecord.id), eq(standings.teamId, teamRecord.id))
      );
      if (!standingRecord) {
        await db.insert(standings).values({
          seasonId: seasonRecord.id,
          teamId: teamRecord.id,
        });
      }

      // Upsert 11 Starter Players deterministically (without Math.random)
      const existingPlayers = await db.select().from(players).where(eq(players.teamId, teamRecord.id));
      if (existingPlayers.length === 0) {
        const positions = ['GK', 'CB', 'CB', 'LB', 'RB', 'CM', 'CM', 'AM', 'LW', 'RW', 'ST'];
        const playersToInsert = positions.map((pos, i) => {
          const baseRating = teamData.overallRating;
          return {
            teamId: teamRecord.id,
            name: `${teamData.shortName} ${pos} ${i + 1}`,
            age: 21 + (i % 7),
            primaryPosition: pos,
            pace: pos === 'LW' || pos === 'RW' || pos === 'RB' || pos === 'LB' ? baseRating + 5 : baseRating - 5,
            shooting: pos === 'ST' ? baseRating + 6 : pos === 'AM' || pos === 'LW' || pos === 'RW' ? baseRating : baseRating - 15,
            passing: pos === 'AM' || pos === 'CM' ? baseRating + 5 : baseRating - 5,
            dribbling: pos === 'LW' || pos === 'RW' || pos === 'AM' ? baseRating + 5 : baseRating - 5,
            defending: pos === 'CB' ? baseRating + 6 : pos === 'LB' || pos === 'RB' ? baseRating + 2 : baseRating - 20,
            physical: pos === 'CB' || pos === 'ST' ? baseRating + 4 : baseRating - 4,
            goalkeeping: pos === 'GK' ? baseRating + 6 : 10,
            overallRating: baseRating,
            potential: baseRating + 4,
          };
        });
        await db.insert(players).values(playersToInsert);
      }
    }

    // 4. Batch Insert 38 Rounds / 380 Fixtures
    const existingFixtures = await db.select().from(fixtures).where(eq(fixtures.seasonId, seasonRecord.id));
    if (existingFixtures.length === 0) {
      console.log(`  📅 Generating 380 fixtures for ${compData.leagueName}...`);
      const pairings = generateDoubleRoundRobin(createdTeamIds.length);
      const roundKickoffs = buildSynchronizedRoundKickoffs(
        firstKickoffBase,
        Math.max(...pairings.map((pairing) => pairing.round)),
        env.MATCH_REAL_DURATION_SECONDS,
        env.ROUND_BREAK_SECONDS,
      );
      const fixturesToInsert = pairings.map((pairing) => {
        return {
          seasonId: seasonRecord.id,
          round: pairing.round,
          homeTeamId: createdTeamIds[pairing.homeTeamIndex] as string,
          awayTeamId: createdTeamIds[pairing.awayTeamIndex] as string,
          scheduledAt: roundKickoffs[pairing.round - 1],
          status: 'SCHEDULED',
        };
      });

      for (let i = 0; i < fixturesToInsert.length; i += 100) {
        await db.insert(fixtures).values(fixturesToInsert.slice(i, i + 100));
      }
      console.log(`  ✅ Generated 38 rounds (380 fixtures) for ${compData.leagueName}.`);
    } else {
      console.log(`  ℹ️ Fixtures already exist for ${compData.leagueName} (${existingFixtures.length} found).`);
    }
  }

  console.log('\n🎉 Seeding complete for all initial competitions!');
}

if (require.main === module) {
  const selectedSeason = parseVirtualSeasonName(process.argv.slice(2));
  seedDatabase(selectedSeason).catch((err) => {
    console.error('❌ Seeding failed:', err);
    process.exitCode = 1;
  }).finally(async () => {
    await client.end();
  });
}
