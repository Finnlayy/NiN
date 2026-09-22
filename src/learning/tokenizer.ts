import { createHash } from 'crypto';
import { ComplexDomain } from '../types';

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'to',
  'for',
  'in',
  'on',
  'with',
  'by',
  'at',
  'from',
  'is',
  'are',
  'was',
  'were',
  'be',
  'this',
  'that',
  'it',
  'its',
  'as',
  'into',
  'using',
  'use',
  'please',
  'solve',
  'compute',
  'derive',
  'write',
  'provide',
  'prove',
  'list',
  'you',
  'should',
  'must',
  'do',
  'so',
  'can',
]);

const SPECIAL_TOKEN_PREFIX = '@@';

/**
 * Normalize a piece of text into lower-case, stemmed word tokens.
 * Stopwords and very short words are dropped to keep the index compact.
 */
export function normalizeTokens(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9+#_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const result: string[] = [];
  for (const raw of words) {
    if (raw.length <= 2) continue;
    if (STOPWORDS.has(raw)) continue;
    result.push(lightStem(raw));
  }
  return result;
}

/**
 * Light deterministic stemmer. It should be stable across runs so the same
 * text always produces the same token set.
 */
export function lightStem(token: string): string {
  if (token.endsWith('ing') && token.length > 6) return token.slice(0, -3);
  if (token.endsWith('ation') && token.length > 7) return token.slice(0, -4);
  if (token.endsWith('ions') && token.length > 6) return token.slice(0, -4);
  if (token.endsWith('tion') && token.length > 6) return token.slice(0, -4);
  if (token.endsWith('es') && token.length > 5) return token.slice(0, -2);
  if (token.endsWith('s') && token.length > 4) return token.slice(0, -1);
  return token;
}

function normalizedSignatureTokens(tokens: string[]): string[] {
  return [...new Set(tokens)].sort();
}

/**
 * Stable SHA-256 fingerprint of the task description tokens. This lets the
 * engine group repeated or near-identical tasks even when the wording differs
 * slightly.
 */
export function taskSignatureHash(tokens: string[]): string {
  return createHash('sha256').update(normalizedSignatureTokens(tokens).join('|')).digest('hex');
}

/** Content-based identifier for error patterns. */
export function errorFingerprint(tokens: string[], errorClass: string): string {
  const seed = `${normalizedSignatureTokens(tokens).join('|')}::${errorClass}`;
  return createHash('sha256').update(seed).digest('hex');
}

/** Hash embedding tokens into a compact numeric vector for cosine similarity. */
export function hashVector(tokens: string[], dimensions: number = 64): number[] {
  const vec = new Array<number>(dimensions).fill(0);
  if (dimensions <= 0) return [];

  for (const raw of tokens) {
    const token = raw.startsWith(SPECIAL_TOKEN_PREFIX) ? raw : `##${raw}`;
    const digest = createHash('sha256').update(token).digest('hex');
    const index = parseInt(digest.slice(0, 8), 16) % dimensions;
    if (index >= 0 && index < dimensions) {
      vec[index] = (vec[index] ?? 0) + 1;
    }
  }

  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  const dot = a.reduce((sum, v, i) => sum + v * b[i]!, 0);
  const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
  if (normA === 0 || normB === 0) return 0;
  return dot / (normA * normB);
}

/**
 * Build the tokenized body of a knowledge entry: normal text plus structure
 * metadata as special tokens so retrieval can match types and tags.
 */
export function knowledgeTokens(entry: {
  title: string;
  body: string;
  domain: ComplexDomain | 'misc';
  algorithmTag?: string;
  contentType: string;
  tags: string[];
}): string[] {
  const textTokens = normalizeTokens(`${entry.title} ${entry.body} ${entry.tags.join(' ')}`);
  const specials = [
    `${SPECIAL_TOKEN_PREFIX}domain:${entry.domain}`,
    `@@content:${entry.contentType}`,
    ...(entry.algorithmTag ? [`${SPECIAL_TOKEN_PREFIX}alg:${entry.algorithmTag}`] : []),
    ...entry.tags.map((tag) => `${SPECIAL_TOKEN_PREFIX}tag:${tag}`),
  ];
  return [...specials, ...textTokens];
}

export function domainTokens(domain: ComplexDomain | 'misc'): string[] {
  return [`@@domain:${domain}`];
}
