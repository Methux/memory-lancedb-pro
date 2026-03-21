# Phase Notes

## Phase A — Foundation Improvements
- **Backup system**: Automated LanceDB backup before destructive operations
- **Neo4j WAL**: Write-ahead log for Graphiti/Neo4j operations
- **Query tracking**: `src/query-tracker.ts` — append-only JSONL tracker for all recall queries

## Phase B — Dedup + Semantic Gate + WAL
- **Deduplication**: Content-hash based dedup to prevent storing duplicate memories
- **Chinese prompts**: Bilingual prompt support for Chinese-language users
- **Semantic gate**: Resonance-gated auto-recall — only inject memories when query resonates above threshold
- **WAL**: Write-ahead log for crash recovery

## Phase C — Salience + Adaptive Resonance + Multi-hop + Emotion
- **Salience optimization**: Importance scoring tuned for better signal-to-noise
- **Adaptive resonance**: Dynamic threshold adjustment based on query history
- **Multi-hop routing**: Detected multi-hop queries skip Graphiti spread, use LanceDB secondary retrieval
- **Emotion calibration**: Sentiment-aware scoring adjustments

## Phase D — Observability + Baseline Lock
- **Query tracker integration**: `recordQuery()` calls in retriever.ts for gated-out and normal returns
- **Observability module**: `src/observability.ts` — `getStats()` aggregates from query-tracking.jsonl (latency, pass rate, hit count, type distribution, hourly trend)
- **Baseline lock**: `benchmarks/baseline.json` — LoCoMo accuracy scores frozen at Phase D completion
  - Overall: 85.1%, Single-hop: 80.1%, Temporal: 76.9%, Multi-hop: 81.2%, Open-ended: 90.2%, Adversarial: 100%
  - Config: voyage-3-large + rerank-2 + graphiti + spread_limit=8 + resonance_threshold=0.45
