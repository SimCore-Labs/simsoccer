export function buildSynchronizedRoundKickoffs(
  firstKickoff: Date,
  roundCount: number,
  matchDurationSeconds: number,
  roundBreakSeconds: number,
): Date[] {
  const roundIntervalMs = (matchDurationSeconds + roundBreakSeconds) * 1000;

  return Array.from(
    { length: roundCount },
    (_, index) => new Date(firstKickoff.getTime() + index * roundIntervalMs),
  );
}
