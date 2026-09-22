import { ClassificationResult, ComplexDomain, PromptContext } from './types';

interface DomainSignature {
  domain: ComplexDomain;
  keywords: RegExp[];
  algorithmTags: Record<string, RegExp[]>;
}

/**
 * Deterministic signature table for high-stakes workflow recognition.
 * Each regular expression is anchored to whole words to reduce false positives.
 */
const DOMAIN_SIGNATURES: readonly DomainSignature[] = [
  {
    domain: 'ml_30core',
    keywords: [
      /\bxgboost\b/,
      /\bgradient boosting\b/,
      /\btransformer\b(?:\s+(?:selection|architecture|tuning|fine[- ]?tuning))?/,
      /\bmodel selection\b/,
      /\bhyper[- ]?parameter\b/,
      /\bneural architecture search\b/,
      /\bensemble\b/,
      /\bcross[- ]validation\b/,
      /\boverfit(?:ting)?\b/,
      /\bregulari(?:s|z)ation\b/,
    ],
    algorithmTags: {
      xgboost: [/\bxgboost\b/, /\bextreme gradient boosting\b/],
      transformer_selection: [/\btransformer\s+selection\b/, /\btransformer\s+architecture\s+selection\b/],
      nas: [/\bneural\s+architecture\s+search\b/],
    },
  },
  {
    domain: 'dev_dp',
    keywords: [
      /\bdynamic programming\b/,
      /\b0\/1\s+knapsack\b/,
      /\bknapsack\b/,
      /\boptimal\s+substructure\b/,
      /\bmemo[ií]?zation\b/,
      /\btabulation\b/,
      /\brecurrence\s+relation\b/,
      /\blongest\s+common\s+subsequence\b/,
      /\bshortest\s+path\b/,
      /\bbellman(?:[- ]?ford)?\b/,
    ],
    algorithmTags: {
      knapsack_01: [/\b0\/1\s+knapsack\b/, /\bzero[- ]?one\s+knapsack\b/],
      lcs: [/\blongest\s+common\s+subsequence\b/],
      bellman_ford: [/\bbellman[- ]?ford\b/],
    },
  },
];

const DEFAULT_THRESHOLD = 1;

/**
 * Count how many keyword groups match the normalized description.
 */
function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((acc, pattern) => acc + (pattern.test(text) ? 1 : 0), 0);
}

/**
 * Identify a concrete algorithm tag from the signature table.
 */
function detectAlgorithmTag(text: string, signatures: readonly DomainSignature[]): string | null {
  for (const signature of signatures) {
    for (const [tag, patterns] of Object.entries(signature.algorithmTags)) {
      if (patterns.some((pattern) => pattern.test(text))) {
        return tag;
      }
    }
  }
  return null;
}

/**
 * Classify a prompt context into a domain, an optional algorithm tag and a
 * complexity score. The caller's explicit `isComplexWorkflow` flag is honored.
 */
export function classifyTask(
  context: PromptContext,
  complexityThreshold: number = DEFAULT_THRESHOLD,
): ClassificationResult {
  const text = `${context.taskDescription ?? ''} ${context.algorithmTag ?? ''} ${context.domainHint ?? ''}`.toLowerCase();

  let bestDomain: ComplexDomain = context.domainHint ?? 'unknown';
  let highestScore = 0;

  for (const signature of DOMAIN_SIGNATURES) {
    const score = countMatches(text, signature.keywords);
    if (score > highestScore) {
      highestScore = score;
      bestDomain = signature.domain;
    }
  }

  if (bestDomain === 'unknown' && context.domainHint) {
    bestDomain = context.domainHint;
  }

  const algorithmTag = context.algorithmTag ?? detectAlgorithmTag(text, DOMAIN_SIGNATURES);
  const scoreBasedComplex = highestScore >= complexityThreshold;
  const isComplex = context.isComplexWorkflow === true || scoreBasedComplex;
  const complexityScore = context.isComplexWorkflow ? Math.max(highestScore, complexityThreshold + 1) : highestScore;

  return {
    domain: bestDomain,
    algorithmTag,
    complexityScore,
    isComplex,
  };
}
