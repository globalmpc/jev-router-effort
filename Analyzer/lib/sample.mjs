import { sha } from './util.mjs';

export const stratumOf = s => `${s.band}|${s.cli}|${s.routing}|${s.kind}`;

/**
 * Deterministic stratified sample: in every stratum take ceil(rate × N) sessions with the
 * lowest sha256(seed:key). Because ranks depend only on (seed, key), the 0-24h picks are
 * identical whether the run covers 24h or 48h. `purposive` keys are added and flagged
 * separately so they never inflate random coverage.
 */
export function stratifiedSample(eligible, { rate = 0.2, seed = 'jev-evidence-v1', purposive = [] } = {}) {
  if (!(rate > 0 && rate <= 1)) throw new Error('rate must be in (0, 1]');
  const strata = new Map();
  for (const s of eligible) {
    const k = stratumOf(s);
    if (!strata.has(k)) strata.set(k, []);
    strata.get(k).push(s);
  }
  const picks = [];
  const table = [];
  for (const [stratum, members] of [...strata].sort(([a], [b]) => a.localeCompare(b))) {
    const ranked = members.map(s => ({ s, rank: sha(`${seed}:${s.key}`) })).sort((a, b) => a.rank.localeCompare(b.rank));
    const n = Math.ceil(rate * members.length);
    for (const { s } of ranked.slice(0, n)) picks.push({ key: s.key, stratum, reason: 'random' });
    table.push({ stratum, eligible: members.length, sampled: n });
  }
  const picked = new Set(picks.map(p => p.key));
  const byKey = new Map(eligible.map(s => [s.key, s]));
  for (const key of purposive) {
    if (picked.has(key) || !byKey.has(key)) continue;
    picks.push({ key, stratum: stratumOf(byKey.get(key)), reason: 'purposive' });
    picked.add(key);
  }
  const random = picks.filter(p => p.reason === 'random').length;
  return {
    seed, rate, picks, strata: table,
    denominator: eligible.length,
    randomSampled: random,
    purposiveSampled: picks.length - random,
    coverage: eligible.length ? random / eligible.length : 0,
  };
}
