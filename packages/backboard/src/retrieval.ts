import type {
  MerchantDocumentCategory,
  RetrievedDocumentChunk,
} from "./types.js";

/** Provider-agnostic corpus entry backing keyword retrieval in the mock adapter. */
export interface IndexedDocument {
  documentId: string;
  fileName: string;
  category: MerchantDocumentCategory;
  version: number;
  sourceTimestamp: string;
  stale: boolean;
  content: string;
}

export const DEFAULT_RETRIEVAL_DEPTH = 4;

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function scoreDocument(queryTerms: string[], content: string): number {
  if (queryTerms.length === 0) {
    return 0;
  }
  const contentTerms = new Set(tokenize(content));
  const hits = queryTerms.filter((term) => contentTerms.has(term)).length;
  return hits / queryTerms.length;
}

function bestSnippet(
  content: string,
  queryTerms: string[],
  maxLen = 240,
): string {
  const terms = new Set(queryTerms);
  const lines = content
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  let best = lines[0] ?? content.slice(0, maxLen);
  let bestScore = -1;
  for (const line of lines) {
    const score = tokenize(line).filter((term) => terms.has(term)).length;
    if (score > bestScore) {
      bestScore = score;
      best = line;
    }
  }
  return best.length > maxLen ? `${best.slice(0, maxLen - 1)}…` : best;
}

/**
 * Deterministic keyword-overlap retrieval standing in for Backboard's real
 * corpus search in the mock adapter. `depth` caps how many chunks come back;
 * per B2, set it high enough to reliably recover policy details, then tune
 * for latency after the first demo.
 */
export function retrieveTopDocuments(
  query: string,
  documents: IndexedDocument[],
  depth: number = DEFAULT_RETRIEVAL_DEPTH,
): RetrievedDocumentChunk[] {
  const queryTerms = tokenize(query);
  return documents
    .map((doc) => ({ doc, score: scoreDocument(queryTerms, doc.content) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, depth)
    .map(({ doc, score }) => ({
      documentId: doc.documentId,
      fileName: doc.fileName,
      category: doc.category,
      version: doc.version,
      sourceTimestamp: doc.sourceTimestamp,
      stale: doc.stale,
      snippet: bestSnippet(doc.content, queryTerms),
      score,
    }));
}

export type ReconciledValueSource = "LIVE_TOOL" | "RAG_DOCUMENT" | "UNKNOWN";

export interface ReconciledValue<T> {
  source: ReconciledValueSource;
  value: T | string | undefined;
  /** True when the best-matching RAG chunk is stale, whether or not it was used. */
  staleWarning: boolean;
}

/**
 * Encodes the non-negotiable B2 rule: RAG output never counts as canonical
 * inventory/capacity. A defined live tool value always wins; retrieval only
 * fills in when no live value exists, and callers can see the answer came
 * from a possibly-stale document.
 */
export function reconcileWithLiveValue<T>(input: {
  ragChunks: RetrievedDocumentChunk[];
  liveValue: T | undefined;
}): ReconciledValue<T> {
  const bestChunk = input.ragChunks[0];
  if (input.liveValue !== undefined) {
    return {
      source: "LIVE_TOOL",
      value: input.liveValue,
      staleWarning: bestChunk?.stale ?? false,
    };
  }
  if (!bestChunk) {
    return { source: "UNKNOWN", value: undefined, staleWarning: false };
  }
  return {
    source: "RAG_DOCUMENT",
    value: bestChunk.snippet,
    staleWarning: bestChunk.stale,
  };
}
