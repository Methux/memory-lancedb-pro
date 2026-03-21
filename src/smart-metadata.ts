import type { MemoryCategory, MemoryTier } from "./memory-categories.js";
import type { DecayableMemory } from "./decay-engine.js";

type LegacyStoreCategory =
  | "preference"
  | "fact"
  | "decision"
  | "entity"
  | "other"
  | "reflection";

type EntryLike = {
  text?: string;
  category?: LegacyStoreCategory;
  importance?: number;
  timestamp?: number;
  metadata?: string;
};

export interface SmartMemoryMetadata {
  l0_abstract: string;
  l1_overview: string;
  l2_content: string;
  memory_category: MemoryCategory;
  tier: MemoryTier;
  access_count: number;
  confidence: number;
  last_accessed_at: number;
  source_session?: string;
  /** Emotional salience score (0-1). Higher = more emotionally significant = decays slower.
   *  Computed at store time via heuristic rules (zero LLM cost). */
  emotional_salience: number;
  [key: string]: unknown;
}

export interface LifecycleMemory {
  id: string;
  importance: number;
  confidence: number;
  tier: MemoryTier;
  accessCount: number;
  createdAt: number;
  lastAccessedAt: number;
  emotionalSalience: number;
}

function clamp01(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function clampCount(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

// ============================================================================
// Emotional Salience — heuristic scoring (zero LLM cost)
// ============================================================================

/** High-salience signal patterns (decisions, strong emotions, firsts, money, people) */
const SALIENCE_BOOSTERS: Array<{ pattern: RegExp; boost: number }> = [
  // Decisions and commitments
  { pattern: /\b(决定|决策|confirmed|decided|commit|approved|批了|拍板|定了)\b/i, boost: 0.3 },
  // Strong emotions
  { pattern: /\b(震惊|惊喜|愤怒|失望|兴奋|amazing|shocked|frustrated|excited|worried|担心)\b/i, boost: 0.25 },
  // First-time events
  { pattern: /\b(第一次|首次|first time|first ever|从未|never before)\b/i, boost: 0.25 },
  // Financial significance
  { pattern: /\b(\d+万|\d+亿|\$[\d,.]+[MBK]|估值|valuation|投资|持仓)\b/i, boost: 0.2 },
  // People and relationships
  { pattern: /\b(Rex|KinY|苡好|光轮|东芯|砺算)\b/i, boost: 0.15 },
  // Lessons learned / mistakes
  { pattern: /\b(教训|踩坑|pitfall|lesson|mistake|bug|故障|挂了|崩了)\b/i, boost: 0.2 },
  // Preferences and identity
  { pattern: /\b(喜欢|讨厌|偏好|prefer|hate|love|always|never)\b/i, boost: 0.15 },
  // Exclamation / emphasis (emotional weight)
  { pattern: /[!！]{2,}|‼️|⚠️|🔴|💀/, boost: 0.1 },
];

/** Low-salience patterns (routine, technical noise) */
const SALIENCE_DAMPENERS: Array<{ pattern: RegExp; dampen: number }> = [
  { pattern: /\b(heartbeat|HEARTBEAT_OK)\b/i, dampen: 0.2 },
  { pattern: /\b(cron|restart|gateway|status)\b/i, dampen: 0.1 },
  { pattern: /\b(debug|stack trace|npm|node_modules|\.tsx?|\.jsx?)\b/i, dampen: 0.1 },
  { pattern: /^\[?(Updated|Added|Removed|Fixed|Set)\]?\s.{0,30}$/i, dampen: 0.15 }, // short auto-generated entries only
];

/**
 * Compute emotional salience from text + category.
 * Returns 0-1. Higher = more emotionally charged / personally significant.
 * Pure heuristic, no LLM call.
 */
export function computeEmotionalSalience(
  text: string,
  category?: string,
  importance?: number,
): number {
  let score = 0.35; // baseline — neutral memory

  // Category boost
  if (category === "decision") score += 0.15;
  if (category === "preference") score += 0.1;
  if (category === "reflection") score += 0.1;

  // Importance as a weak signal
  if (typeof importance === "number" && importance > 0.8) score += 0.1;
  if (typeof importance === "number" && importance > 0.9) score += 0.05;

  // Pattern matching
  for (const { pattern, boost } of SALIENCE_BOOSTERS) {
    if (pattern.test(text)) score += boost;
  }
  for (const { pattern, dampen } of SALIENCE_DAMPENERS) {
    if (pattern.test(text)) score -= dampen;
  }

  return Math.min(1, Math.max(0, score));
}

// ============================================================================
// Emotion Calibration — rule-based post-processing for LLM valence
// ============================================================================

/** Strong emotion signal words (positive or negative) */
const STRONG_EMOTION_PATTERNS = [
  /太好了|太棒了|amazing|incredible|wonderful|fantastic|excellent/i,
  /terrible|horrible|awful|disgusting|devastating/i,
  /fuck|shit|damn|靠|卧槽|我去|妈的/i,
  /哈哈哈|lol|lmao|rofl|😂|🤣/i,
  /[!！]{3,}/,
  /heartbroken|ecstatic|furious|thrilled|terrified/i,
  /崩溃|暴怒|狂喜|绝望|震惊|兴奋死了/i,
];

/** Factual / data-heavy text indicators */
const FACTUAL_PATTERNS = [
  /估值|revenue|valuation|profit|loss|margin/i,
  /[$￥€£]/,
  /%/,
];

/**
 * Calibrate LLM-returned emotion valence with rule-based post-processing.
 *
 * Fixes two common LLM failure modes:
 * 1. Strong emotional text scored as neutral (0.4-0.6) → push toward extremes
 * 2. Pure factual/data text scored as emotional → compress toward neutral
 *
 * @param text - The memory text
 * @param rawValence - LLM-returned valence (0-1, 0.5 = neutral)
 * @returns Calibrated valence (0-1)
 */
export function calibrateEmotion(text: string, rawValence: number): number {
  if (!Number.isFinite(rawValence)) return 0.5;

  // Check for strong emotion signals
  const hasStrongEmotion = STRONG_EMOTION_PATTERNS.some(p => p.test(text));

  // Check if text is factual/data-heavy
  const digitChars = (text.match(/\d/g) || []).length;
  const digitRatio = text.length > 0 ? digitChars / text.length : 0;
  const hasFactualSignals = digitRatio > 0.3 || FACTUAL_PATTERNS.some(p => p.test(text));

  let calibrated = rawValence;

  // Fix 1: Strong emotion + neutral valence → push to 0.3 or 0.7
  if (hasStrongEmotion && rawValence >= 0.4 && rawValence <= 0.6) {
    // Determine direction: below 0.5 → negative, above → positive
    calibrated = rawValence <= 0.5 ? 0.3 : 0.7;
  }

  // Fix 2: Factual text → compress to 0.45-0.55
  if (hasFactualSignals && !hasStrongEmotion) {
    if (calibrated < 0.45) calibrated = 0.45;
    if (calibrated > 0.55) calibrated = 0.55;
  }

  return Math.min(1, Math.max(0, calibrated));
}

function normalizeTier(value: unknown): MemoryTier {
  switch (value) {
    case "core":
    case "working":
    case "peripheral":
      return value;
    default:
      return "working";
  }
}

export function reverseMapLegacyCategory(
  oldCategory: LegacyStoreCategory | undefined,
  text = "",
): MemoryCategory {
  switch (oldCategory) {
    case "preference":
      return "preferences";
    case "entity":
      return "entities";
    case "decision":
      return "events";
    case "other":
      return "patterns";
    case "fact":
      if (
        /\b(my |i am |i'm |name is |叫我|我的|我是)\b/i.test(text) &&
        text.length < 200
      ) {
        return "profile";
      }
      return "cases";
    default:
      return "patterns";
  }
}

function defaultOverview(text: string): string {
  return `- ${text}`;
}

function normalizeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function parseSmartMetadata(
  rawMetadata: string | undefined,
  entry: EntryLike = {},
): SmartMemoryMetadata {
  let parsed: Record<string, unknown> = {};
  if (rawMetadata) {
    try {
      const obj = JSON.parse(rawMetadata);
      if (obj && typeof obj === "object") {
        parsed = obj as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
  }

  const text = entry.text ?? "";
  const timestamp =
    typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
      ? entry.timestamp
      : Date.now();

  const memoryCategory = reverseMapLegacyCategory(entry.category, text);
  const l0 = normalizeText(parsed.l0_abstract, text);
  const l2 = normalizeText(parsed.l2_content, text);
  const normalized: SmartMemoryMetadata = {
    ...parsed,
    l0_abstract: l0,
    l1_overview: normalizeText(parsed.l1_overview, defaultOverview(l0)),
    l2_content: l2,
    memory_category:
      typeof parsed.memory_category === "string"
        ? (parsed.memory_category as MemoryCategory)
        : memoryCategory,
    tier: normalizeTier(parsed.tier),
    access_count: clampCount(parsed.access_count, 0),
    confidence: clamp01(parsed.confidence, 0.7),
    last_accessed_at: clampCount(parsed.last_accessed_at, timestamp),
    source_session:
      typeof parsed.source_session === "string" ? parsed.source_session : undefined,
    emotional_salience: clamp01(
      parsed.emotional_salience,
      computeEmotionalSalience(text, entry.category, entry.importance),
    ),
  };

  return normalized;
}

export function buildSmartMetadata(
  entry: EntryLike,
  patch: Partial<SmartMemoryMetadata> = {},
): SmartMemoryMetadata {
  const base = parseSmartMetadata(entry.metadata, entry);
  const text = entry.text ?? "";

  // Calibrate emotional salience: fix LLM mis-scoring of strong emotions / factual text
  const rawSalience = clamp01(
    patch.emotional_salience ?? base.emotional_salience,
    base.emotional_salience,
  );
  const calibratedSalience = calibrateEmotion(text, rawSalience);

  return {
    ...base,
    ...patch,
    l0_abstract: normalizeText(patch.l0_abstract, base.l0_abstract),
    l1_overview: normalizeText(patch.l1_overview, base.l1_overview),
    l2_content: normalizeText(patch.l2_content, base.l2_content),
    memory_category:
      typeof patch.memory_category === "string"
        ? patch.memory_category
        : base.memory_category,
    tier: normalizeTier(patch.tier ?? base.tier),
    access_count: clampCount(patch.access_count, base.access_count),
    confidence: clamp01(patch.confidence, base.confidence),
    last_accessed_at: clampCount(
      patch.last_accessed_at,
      base.last_accessed_at || entry.timestamp || Date.now(),
    ),
    source_session:
      typeof patch.source_session === "string"
        ? patch.source_session
        : base.source_session,
    emotional_salience: calibratedSalience,
  };
}

// Metadata array size caps — prevent unbounded JSON growth
const MAX_SOURCES = 20;
const MAX_HISTORY = 50;
const MAX_RELATIONS = 16;

export function stringifySmartMetadata(
  metadata: SmartMemoryMetadata | Record<string, unknown>,
): string {
  const capped = { ...metadata } as Record<string, unknown>;

  // Cap array fields to prevent metadata bloat
  if (Array.isArray(capped.sources) && capped.sources.length > MAX_SOURCES) {
    capped.sources = capped.sources.slice(-MAX_SOURCES); // keep most recent
  }
  if (Array.isArray(capped.history) && capped.history.length > MAX_HISTORY) {
    capped.history = capped.history.slice(-MAX_HISTORY);
  }
  if (Array.isArray(capped.relations) && capped.relations.length > MAX_RELATIONS) {
    capped.relations = capped.relations.slice(0, MAX_RELATIONS);
  }

  return JSON.stringify(capped);
}

export function toLifecycleMemory(
  id: string,
  entry: EntryLike,
): LifecycleMemory {
  const metadata = parseSmartMetadata(entry.metadata, entry);
  const createdAt =
    typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
      ? entry.timestamp
      : Date.now();

  return {
    id,
    importance:
      typeof entry.importance === "number" && Number.isFinite(entry.importance)
        ? entry.importance
        : 0.7,
    confidence: metadata.confidence,
    tier: metadata.tier,
    accessCount: metadata.access_count,
    createdAt,
    lastAccessedAt: metadata.last_accessed_at || createdAt,
    emotionalSalience: metadata.emotional_salience,
  };
}

/**
 * Parse a memory entry into both a DecayableMemory (for the decay engine)
 * and the raw SmartMemoryMetadata (for in-place mutation before write-back).
 */
export function getDecayableFromEntry(
  entry: EntryLike & { id?: string },
): { memory: DecayableMemory; meta: SmartMemoryMetadata } {
  const meta = parseSmartMetadata(entry.metadata, entry);
  const createdAt =
    typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
      ? entry.timestamp
      : Date.now();

  const memory: DecayableMemory = {
    id: (entry as { id?: string }).id ?? "",
    importance:
      typeof entry.importance === "number" && Number.isFinite(entry.importance)
        ? entry.importance
        : 0.7,
    confidence: meta.confidence,
    tier: meta.tier,
    accessCount: meta.access_count,
    createdAt,
    lastAccessedAt: meta.last_accessed_at || createdAt,
    emotionalSalience: meta.emotional_salience,
  };

  return { memory, meta };
}

// ============================================================================
// Contextual Support — optional extension to SmartMemoryMetadata
// ============================================================================

/** Predefined context vocabulary for support slices */
export const SUPPORT_CONTEXT_VOCABULARY = [
  "general", "morning", "afternoon", "evening", "night",
  "weekday", "weekend", "work", "leisure",
  "summer", "winter", "travel",
] as const;

export type SupportContext = (typeof SUPPORT_CONTEXT_VOCABULARY)[number] | string;

/** Max number of context slices per memory to prevent metadata bloat */
export const MAX_SUPPORT_SLICES = 8;

/** A single context-specific support slice */
export interface ContextualSupport {
  context: SupportContext;
  confirmations: number;
  contradictions: number;
  strength: number;       // confirmations / (confirmations + contradictions)
  last_observed_at: number;
}

/** V2 support info with per-context slices */
export interface SupportInfoV2 {
  global_strength: number;      // weighted average across all slices
  total_observations: number;   // sum of all confirmations + contradictions
  slices: ContextualSupport[];
}

/**
 * Normalize a raw context label to a canonical context.
 * Maps common variants (e.g. "晚上" → "evening") and falls back to "general".
 */
export function normalizeContext(raw: string | undefined): SupportContext {
  if (!raw || !raw.trim()) return "general";
  const lower = raw.trim().toLowerCase();

  // Direct vocabulary match
  if ((SUPPORT_CONTEXT_VOCABULARY as readonly string[]).includes(lower)) {
    return lower as SupportContext;
  }

  // Common Chinese/English mappings
  const aliases: Record<string, SupportContext> = {
    "早上": "morning", "上午": "morning", "早晨": "morning",
    "下午": "afternoon", "傍晚": "evening", "晚上": "evening",
    "深夜": "night", "夜晚": "night", "凌晨": "night",
    "工作日": "weekday", "平时": "weekday",
    "周末": "weekend", "假日": "weekend", "休息日": "weekend",
    "工作": "work", "上班": "work", "办公": "work",
    "休闲": "leisure", "放松": "leisure", "休息": "leisure",
    "夏天": "summer", "夏季": "summer",
    "冬天": "winter", "冬季": "winter",
    "旅行": "travel", "出差": "travel", "旅游": "travel",
  };

  return aliases[lower] || lower; // keep as custom context if not mapped
}

/**
 * Parse support_info from metadata JSON. Handles V1 (flat) → V2 (sliced) migration.
 */
export function parseSupportInfo(raw: unknown): SupportInfoV2 {
  const defaultV2: SupportInfoV2 = {
    global_strength: 0.5,
    total_observations: 0,
    slices: [],
  };

  if (!raw || typeof raw !== "object") return defaultV2;
  const obj = raw as Record<string, unknown>;

  // V2 format: has slices array
  if (Array.isArray(obj.slices)) {
    return {
      global_strength: typeof obj.global_strength === "number" ? obj.global_strength : 0.5,
      total_observations: typeof obj.total_observations === "number" ? obj.total_observations : 0,
      slices: (obj.slices as Record<string, unknown>[]).filter(
        s => s && typeof s.context === "string",
      ).map(s => ({
        context: String(s.context),
        confirmations: typeof s.confirmations === "number" && s.confirmations >= 0 ? s.confirmations : 0,
        contradictions: typeof s.contradictions === "number" && s.contradictions >= 0 ? s.contradictions : 0,
        strength: typeof s.strength === "number" && s.strength >= 0 && s.strength <= 1 ? s.strength : 0.5,
        last_observed_at: typeof s.last_observed_at === "number" ? s.last_observed_at : Date.now(),
      })),
    };
  }

  // V1 format: flat { confirmations, contradictions, strength }
  const conf = typeof obj.confirmations === "number" ? obj.confirmations : 0;
  const contra = typeof obj.contradictions === "number" ? obj.contradictions : 0;
  const total = conf + contra;
  if (total === 0) return defaultV2;

  return {
    global_strength: total > 0 ? conf / total : 0.5,
    total_observations: total,
    slices: [{
      context: "general",
      confirmations: conf,
      contradictions: contra,
      strength: total > 0 ? conf / total : 0.5,
      last_observed_at: Date.now(),
    }],
  };
}

/**
 * Update support stats for a specific context.
 * Returns a new SupportInfoV2 with the updated slice.
 */
export function updateSupportStats(
  existing: SupportInfoV2,
  contextLabel: string | undefined,
  event: "support" | "contradict",
): SupportInfoV2 {
  const ctx = normalizeContext(contextLabel);
  const base = { ...existing, slices: [...existing.slices.map(s => ({ ...s }))] };

  // Find or create the context slice
  let slice = base.slices.find(s => s.context === ctx);
  if (!slice) {
    slice = { context: ctx, confirmations: 0, contradictions: 0, strength: 0.5, last_observed_at: Date.now() };
    base.slices.push(slice);
  }

  // Update slice
  if (event === "support") slice.confirmations++;
  else slice.contradictions++;
  const sliceTotal = slice.confirmations + slice.contradictions;
  slice.strength = sliceTotal > 0 ? slice.confirmations / sliceTotal : 0.5;
  slice.last_observed_at = Date.now();

  // Cap slices (keep most recently observed, but preserve dropped evidence).
  // NOTE: Evidence from slices dropped in *previous* updates is already baked
  // into total_observations/global_strength, so those values may drift slightly
  // over many truncation cycles. This is an accepted trade-off for bounded JSON size.
  let slices = base.slices;
  let droppedConf = 0, droppedContra = 0;
  if (slices.length > MAX_SUPPORT_SLICES) {
    slices = slices
      .sort((a, b) => b.last_observed_at - a.last_observed_at);
    const dropped = slices.slice(MAX_SUPPORT_SLICES);
    for (const d of dropped) {
      droppedConf += d.confirmations;
      droppedContra += d.contradictions;
    }
    slices = slices.slice(0, MAX_SUPPORT_SLICES);
  }

  // Recompute global strength including evidence from dropped slices
  let totalConf = droppedConf, totalContra = droppedContra;
  for (const s of slices) {
    totalConf += s.confirmations;
    totalContra += s.contradictions;
  }
  const totalObs = totalConf + totalContra;
  const global_strength = totalObs > 0 ? totalConf / totalObs : 0.5;

  return { global_strength, total_observations: totalObs, slices };
}
