/**
 * Observability — aggregated stats from query-tracking.jsonl
 */

import { getRecentQueries, type QueryRecord } from "./query-tracker.js";

export interface QueryStats {
  totalQueries: number;
  avgLatencyMs: number;
  resonancePassRate: number;
  avgHitCount: number;
  queryTypeDistribution: Record<string, number>;
  hourlyTrend: { hour: string; count: number }[];
}

export async function getStats(maxRecords = 1000): Promise<QueryStats> {
  const records = await getRecentQueries(maxRecords);

  if (records.length === 0) {
    return {
      totalQueries: 0,
      avgLatencyMs: 0,
      resonancePassRate: 0,
      avgHitCount: 0,
      queryTypeDistribution: {},
      hourlyTrend: [],
    };
  }

  const totalQueries = records.length;
  const avgLatencyMs = Math.round(
    records.reduce((sum, r) => sum + r.latency_ms, 0) / totalQueries
  );
  const resonancePassRate = +(
    records.filter((r) => r.resonancePass).length / totalQueries
  ).toFixed(3);
  const avgHitCount = +(
    records.reduce((sum, r) => sum + r.hitCount, 0) / totalQueries
  ).toFixed(2);

  // Query type distribution
  const queryTypeDistribution: Record<string, number> = {};
  for (const r of records) {
    queryTypeDistribution[r.queryType] =
      (queryTypeDistribution[r.queryType] || 0) + 1;
  }

  // Hourly trend — last 24h bucketed by hour
  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;
  const hourBuckets = new Map<string, number>();

  for (let i = 0; i < 24; i++) {
    const d = new Date(now - i * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
    hourBuckets.set(key, 0);
  }

  for (const r of records) {
    const ts = new Date(r.timestamp).getTime();
    if (ts < cutoff) continue;
    const key = r.timestamp.slice(0, 13);
    if (hourBuckets.has(key)) {
      hourBuckets.set(key, hourBuckets.get(key)! + 1);
    }
  }

  const hourlyTrend = Array.from(hourBuckets.entries())
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => a.hour.localeCompare(b.hour));

  return {
    totalQueries,
    avgLatencyMs,
    resonancePassRate,
    avgHitCount,
    queryTypeDistribution,
    hourlyTrend,
  };
}
