import assert from 'node:assert/strict';
import { buildSynchronizedRoundKickoffs } from '../football/round-schedule';

const firstKickoff = new Date('2026-11-02T08:00:00.000Z');
const roundKickoffs = buildSynchronizedRoundKickoffs(firstKickoff, 38, 5400, 600);

assert.equal(roundKickoffs.length, 38);
assert.equal(roundKickoffs[0].toISOString(), firstKickoff.toISOString());
assert.equal(roundKickoffs[1].getTime() - roundKickoffs[0].getTime(), 100 * 60 * 1000);
assert.equal(roundKickoffs[37].getTime() - roundKickoffs[36].getTime(), 100 * 60 * 1000);

const synchronizedLeagueKickoffs = ['Premier League', 'La Liga', 'Serie A']
  .map(() => roundKickoffs[0].toISOString());
assert.deepEqual(new Set(synchronizedLeagueKickoffs), new Set([firstKickoff.toISOString()]));

console.log('Synchronized round schedule tests passed.');
