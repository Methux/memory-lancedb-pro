/**
 * Query Tracker
 *
 * Lightweight, append-only JSONL tracker for every recall query.
 * Fire-and-forget writes — never blocks the recall path.
 * Persisted to ~/.openclaw/memory/query-tracking.jsonl.
 */

import { appendFile, readFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const TRACKING_PATH = join(homedir(), ".openclaw", "memory", "query-tracking.jsonl");

export interface QueryRecord {
  timestamp: string;
  query: string;
  source: "auto" | "manual" | "cli";
  hitCount: number;
  topScore: number;
  latency_ms: number;
  queryType: "single" | "multi-hop" | "gated-out";
  resonancePass: boolean;
}

let dirEnsured = false;

/**
 * Record a query to the tracking log (fire-and-forget).
 * Errors are silently swallowed to avoid impacting recall latency.
 */
export function recordQuery(data: QueryRecord): void {
  const line = JSON.stringify(data) + "\n";
  const doWrite = async () => {
    if (!dirEnsured) {
      await mkdir(dirname(TRACKING_PATH), { recursive: true });
      dirEnsured = true;
    }
    await appendFile(TRACKING_PATH, line, "utf8");
  };
  doWrite().catch(() => {});
}

/**
 * Read the most recent N query records from the tracking log.
 */
export async function getRecentQueries(n: number = 100): Promise<QueryRecord[]> {
  try {
    const raw = await readFile(TRACKING_PATH, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const recent = lines.slice(-n);
    return recent.map((line) => JSON.parse(line) as QueryRecord);
  } catch {
    return [];
  }
}
