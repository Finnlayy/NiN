import { KnowledgeEntry, ResearchOptions, ResearchResult } from './schemas';
import { normalizeTokens } from './tokenizer';
import { LearningStore } from './store';

/**
 * Research / retrieval engine over the Knowledge Base. It finds prior
 * solutions, research summaries, corrections and algorithms that may improve
 * the current solution.
 */

function tokenSet(tokens: string[]): Set<string> {
  return new Set(tokens);
}

function jaccard(a: string[], b: string[]): number {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function textTokens(entry: KnowledgeEntry): string[] {
  return [
    ...normalizeTokens(entry.title),
    ...normalizeTokens(entry.body),
    ...normalizeTokens(entry.tags.join(' ')),
  ];
}

/**
 * Search the Knowledge Base for the best available research and prior
 * solutions for a task signature.
 */
export function researchKnowledge(
  store: LearningStore,
  queryTokens: string[],
  options: ResearchOptions = {},
): ResearchResult[] {
  const {
    limit = 5,
    domain,
    algorithmTag,
    minRelevance = 0,
    includeCorrections = true,
  } = options;

  const searchTokens = [
    ...queryTokens,
    ...(domain ? [`@@domain:${domain}`] : []),
    ...(algorithmTag ? [`@@alg:${algorithmTag}`] : []),
  ];

  const results: ResearchResult[] = [];
  for (const entry of store.listKnowledge()) {
    if (domain && entry.domain !== domain) continue;
    if (algorithmTag && entry.algorithmTag !== algorithmTag) continue;
    if (!includeCorrections && entry.contentType === 'correction') continue;

    const entryTokens = entry.tokenIds.length > 0 ? entry.tokenIds : textTokens(entry);
    const tokenScore = jaccard(searchTokens, entryTokens);
    const matchedTags = entry.tags.filter((tag) => queryTokens.some((token) => token.includes(tag) || tag.includes(token)));
    const tagScore = matchedTags.length > 0 ? Math.min(1, matchedTags.length / 2) : 0;
    const qualityScore = entry.qualityScore ?? 0.5;
    const embeddingScore = null;

    const relevanceScore = round(
      Math.min(1, (tokenScore * 0.7 + tagScore * 0.2 + qualityScore * 0.1),
    ));

    if (relevanceScore < minRelevance) continue;

    const reasons: string[] = [];
    if (tokenScore > 0) reasons.push(`token overlap ${tokenScore.toFixed(3)}`);
    if (matchedTags.length > 0) reasons.push(`matched tags ${matchedTags.join(', ')}`);
    if (entry.contentType === 'correction') reasons.push('contains a recorded correction');

    results.push({
      entry,
      relevanceScore,
      tokenScore,
      embeddingScore,
      tagScore,
      matchedTags,
      reasons,
    });
  }

  return results
    .sort((a, b) => b.relevanceScore - a.relevanceScore || b.tokenScore - a.tokenScore)
    .slice(0, limit);
}

/**
 * Build a compact, injectable research brief that can be prepended to the
 * execution prompt so the model benefits from the Knowledge Base.
 */
export function composeResearchBrief(results: ResearchResult[], maxEntries: number = 3): string {
  if (results.length === 0) {
    return 'No prior Knowledge Base entry matched this task. Execute from first principles and retain the outcome.';
  }

  const lines: string[] = ['Knowledge Base context retrieved for this task:'];
  for (const result of results.slice(0, maxEntries)) {
    lines.push('---');
    lines.push(`- ${result.entry.contentType}: ${result.entry.title}`);
    lines.push(`- relevance: ${result.relevanceScore.toFixed(3)}`);
    if (result.entry.algorithmTag) lines.push(`- algorithm: ${result.entry.algorithmTag}`);
    lines.push(`- ${result.entry.body.trim().replace(/\s+/g, ' ')}`);
    if (result.entry.evidence.length > 0) {
      lines.push(
        `- evidence: ${result.entry.evidence.map((e) => `${e.key}=${e.value}`).join('; ')}`,
      );
    }
  }
  lines.push('---');
  lines.push('Use the retrieved knowledge to improve correctness, but validate against the actual task constraints.');
  return lines.join('\n');
}

function round(value: number): number {
  return Math.round(value * 100000) / 100000;
}
