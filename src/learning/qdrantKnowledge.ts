import { createHash } from 'crypto';
import { QdrantClient, type Schemas } from '@qdrant/js-client-rest';
import { KnowledgeEntry } from './schemas';
import { hashVector, knowledgeTokens } from './tokenizer';

/**
 * Qdrant collection that holds Knowledge Base entries.
 * The learning JSON file stays the snapshot for skills, outcomes and the
 * other records. Knowledge entries themselves are stored as points here.
 */
export const KNOWLEDGE_COLLECTION = 'knowledge_library';

/** Fixed width of the hashed knowledge vector. Matches `hashVector`. */
export const KNOWLEDGE_VECTOR_SIZE = 64;

export type QdrantKnowledgeMode = 'qdrant' | 'file_fallback';

export interface QdrantKnowledgeStatus {
  mode: QdrantKnowledgeMode;
  collection: string;
  vectorsStored: number;
  url: string | null;
}

export interface KnowledgeVectorQuery {
  vector: number[];
  limit: number;
  domain?: string;
  algorithmTag?: string;
  includeCorrections: boolean;
}

export interface KnowledgeVectorHit {
  entry: KnowledgeEntry;
  score: number;
}

/**
 * Vector index for knowledge entries. A file fallback reports `file_fallback`
 * and does not touch the network.
 */
export interface KnowledgeVectorIndex {
  status(): QdrantKnowledgeStatus;
  loadAll(): Promise<KnowledgeEntry[]>;
  sync(entries: readonly KnowledgeEntry[]): Promise<void>;
  search(query: KnowledgeVectorQuery): Promise<KnowledgeVectorHit[]>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Qdrant point ids are UUIDs. Stable ids pass through; anything else is hashed. */
export function knowledgePointId(id: string): string {
  if (UUID_RE.test(id)) return id.toLowerCase();
  const hex = createHash('sha256').update(`knowledge:${id}`).digest('hex');
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/** Vector indexed in Qdrant. A supplied 64-d embedding wins over the hash. */
export function knowledgeVector(entry: KnowledgeEntry): number[] {
  if (entry.embedding && entry.embedding.length === KNOWLEDGE_VECTOR_SIZE) {
    return entry.embedding;
  }
  const tokens = entry.tokenIds.length > 0
    ? entry.tokenIds
    : knowledgeTokens({
        title: entry.title,
        body: entry.body,
        domain: entry.domain,
        algorithmTag: entry.algorithmTag,
        contentType: entry.contentType,
        tags: entry.tags,
      });
  return hashVector(tokens, KNOWLEDGE_VECTOR_SIZE);
}

/** Payload stored on the point. Undefined fields are dropped. */
export function knowledgePayload(entry: KnowledgeEntry): Record<string, unknown> {
  return JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
}

const CONTENT_TYPES = [
  'note',
  'solution',
  'algorithm',
  'research',
  'correction',
  'evaluation_report',
] as const;

type KnowledgeContentType = (typeof CONTENT_TYPES)[number];

function asContentType(value: string): KnowledgeContentType | null {
  switch (value) {
    case 'note':
    case 'solution':
    case 'algorithm':
    case 'research':
    case 'correction':
    case 'evaluation_report':
      return value;
    default:
      return null;
  }
}

/** Rebuild a knowledge entry from a Qdrant payload. Invalid points are skipped. */
export function knowledgeEntryFromPayload(payload: unknown): KnowledgeEntry | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;
  if (typeof raw.id !== 'string' || typeof raw.namespace !== 'string') return null;
  if (typeof raw.title !== 'string' || typeof raw.body !== 'string') return null;
  if (typeof raw.contentType !== 'string') return null;
  const contentType = asContentType(raw.contentType);
  if (!contentType) return null;
  if (typeof raw.domain !== 'string') return null;
  if (!Array.isArray(raw.tags) || !raw.tags.every((tag) => typeof tag === 'string')) return null;
  if (!Array.isArray(raw.tokenIds) || !raw.tokenIds.every((token) => typeof token === 'string')) return null;
  if (!raw.source || typeof raw.source !== 'object') return null;
  const source = raw.source as Record<string, unknown>;
  if (source.kind !== 'internal' && source.kind !== 'external') return null;
  if (!Array.isArray(raw.evidence)) return null;
  if (typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string') return null;

  const evidence: KnowledgeEntry['evidence'] = [];
  for (const item of raw.evidence) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.key !== 'string' || typeof record.value !== 'string') continue;
    evidence.push({ key: record.key, value: record.value });
  }

  const entry: KnowledgeEntry = {
    id: raw.id,
    namespace: raw.namespace,
    title: raw.title,
    contentType,
    domain: raw.domain as KnowledgeEntry['domain'],
    body: raw.body,
    tags: raw.tags as string[],
    tokenIds: raw.tokenIds as string[],
    source: {
      kind: source.kind,
      ...(typeof source.ref === 'string' ? { ref: source.ref } : {}),
    },
    evidence,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };

  if (typeof raw.algorithmTag === 'string') entry.algorithmTag = raw.algorithmTag;
  if (typeof raw.qualityScore === 'number') entry.qualityScore = raw.qualityScore;
  if (Array.isArray(raw.embedding) && raw.embedding.every((value) => typeof value === 'number')) {
    entry.embedding = raw.embedding as number[];
  }
  return entry;
}

/**
 * Union of the JSON snapshot and the Qdrant collection.
 * The newer `updatedAt` wins for the same id.
 */
export function mergeKnowledgeEntries(
  local: readonly KnowledgeEntry[],
  remote: readonly KnowledgeEntry[],
): KnowledgeEntry[] {
  const byId = new Map<string, KnowledgeEntry>();
  for (const entry of remote) byId.set(entry.id, entry);
  for (const entry of local) {
    const existing = byId.get(entry.id);
    if (!existing || existing.updatedAt < entry.updatedAt) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

export function qdrantLimbState(mode: QdrantKnowledgeMode): 'SYNCED' | 'FILE_FALLBACK' {
  switch (mode) {
    case 'qdrant':
      return 'SYNCED';
    case 'file_fallback':
      return 'FILE_FALLBACK';
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

function readVectorSize(value: unknown): number | null {
  if (!value || typeof value !== 'object' || !('size' in value)) return null;
  const size = (value as { size: unknown }).size;
  return typeof size === 'number' ? size : null;
}

function vectorSizeOf(info: Schemas['CollectionInfo']): number | null {
  const vectors = info.config.params.vectors;
  const direct = readVectorSize(vectors);
  if (direct !== null) return direct;
  if (!vectors || typeof vectors !== 'object') return null;
  for (const params of Object.values(vectors as Record<string, unknown>)) {
    const size = readVectorSize(params);
    if (size !== null) return size;
  }
  return null;
}

function buildFilter(query: KnowledgeVectorQuery): Schemas['Filter'] | undefined {
  const must: Schemas['Condition'][] = [];
  const mustNot: Schemas['Condition'][] = [];
  if (query.domain) {
    must.push({ key: 'domain', match: { value: query.domain } });
  }
  if (query.algorithmTag) {
    must.push({ key: 'algorithmTag', match: { value: query.algorithmTag } });
  }
  if (!query.includeCorrections) {
    mustNot.push({ key: 'contentType', match: { value: 'correction' } });
  }
  if (must.length === 0 && mustNot.length === 0) return undefined;
  return {
    ...(must.length > 0 ? { must } : {}),
    ...(mustNot.length > 0 ? { must_not: mustNot } : {}),
  };
}

function isAlreadyExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|409/i.test(message);
}

/**
 * HTTP client for the `knowledge_library` collection.
 * Opens only when `QDRANT_URL` is set. A refused connection degrades to the
 * JSON snapshot instead of blocking the learning server.
 */
export class QdrantKnowledgeIndex implements KnowledgeVectorIndex {
  private vectorsStored: number;

  private constructor(
    private readonly mode: QdrantKnowledgeMode,
    private readonly client: QdrantClient | null,
    readonly collection: string,
    readonly url: string | null,
    vectorsStored: number,
  ) {
    this.vectorsStored = vectorsStored;
  }

  static async open(env: NodeJS.ProcessEnv = process.env): Promise<QdrantKnowledgeIndex> {
    const url = env.QDRANT_URL?.trim() ?? '';
    const collection = env.QDRANT_KNOWLEDGE_COLLECTION?.trim() || KNOWLEDGE_COLLECTION;
    if (!url) {
      return new QdrantKnowledgeIndex('file_fallback', null, collection, null, 0);
    }

    const apiKey = env.QDRANT_API_KEY?.trim();
    const client = new QdrantClient({
      url,
      ...(apiKey ? { apiKey } : {}),
      timeout: 5,
      checkCompatibility: false,
    });

    try {
      await client.getCollections();
      const index = new QdrantKnowledgeIndex('qdrant', client, collection, url, 0);
      await index.ensureCollection();
      index.vectorsStored = await index.countRemote();
      return index;
    } catch (error) {
      console.error(`Qdrant knowledge index unavailable at ${url}:`, error);
      return new QdrantKnowledgeIndex('file_fallback', null, collection, url, 0);
    }
  }

  status(): QdrantKnowledgeStatus {
    return {
      mode: this.mode,
      collection: this.collection,
      vectorsStored: this.vectorsStored,
      url: this.url,
    };
  }

  async loadAll(): Promise<KnowledgeEntry[]> {
    const client = this.requireClient();
    const entries: KnowledgeEntry[] = [];
    let offset: string | number | undefined;
    for (;;) {
      const page = await client.scroll(this.collection, {
        limit: 256,
        offset,
        with_payload: true,
        with_vector: false,
      });
      for (const point of page.points) {
        const entry = knowledgeEntryFromPayload(point.payload);
        if (entry) entries.push(entry);
      }
      const next = page.next_page_offset;
      if (typeof next !== 'string' && typeof next !== 'number') break;
      offset = next;
    }
    this.vectorsStored = entries.length;
    return entries;
  }

  async sync(entries: readonly KnowledgeEntry[]): Promise<void> {
    const client = this.requireClient();
    await this.ensureCollection();
    const points = entries.map((entry) => ({
      id: knowledgePointId(entry.id),
      vector: knowledgeVector(entry),
      payload: knowledgePayload(entry),
    }));

    const chunkSize = 64;
    for (let index = 0; index < points.length; index += chunkSize) {
      const chunk = points.slice(index, index + chunkSize);
      await client.upsert(this.collection, { wait: true, points: chunk });
    }

    const keep = new Set(points.map((point) => point.id));
    const existing = await this.scrollPointIds();
    const remove = existing.filter((id) => !keep.has(id));
    if (remove.length > 0) {
      await client.delete(this.collection, { wait: true, points: remove });
    }
    this.vectorsStored = entries.length;
  }

  async search(query: KnowledgeVectorQuery): Promise<KnowledgeVectorHit[]> {
    const client = this.requireClient();
    const response = await client.query(this.collection, {
      query: query.vector,
      filter: buildFilter(query),
      limit: query.limit,
      with_payload: true,
    });
    const hits: KnowledgeVectorHit[] = [];
    for (const point of response.points) {
      const entry = knowledgeEntryFromPayload(point.payload);
      if (!entry) continue;
      hits.push({ entry, score: point.score });
    }
    return hits;
  }

  private requireClient(): QdrantClient {
    if (this.mode !== 'qdrant' || !this.client) {
      throw new Error('Qdrant knowledge index is not connected.');
    }
    return this.client;
  }

  private async ensureCollection(): Promise<void> {
    const client = this.requireClient();
    const collections = await client.getCollections();
    const exists = collections.collections.some((collection) => collection.name === this.collection);
    if (!exists) {
      try {
        await client.createCollection(this.collection, {
          vectors: { size: KNOWLEDGE_VECTOR_SIZE, distance: 'Cosine' },
        });
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    }

    const info = await client.getCollection(this.collection);
    const size = vectorSizeOf(info);
    if (size !== null && size !== KNOWLEDGE_VECTOR_SIZE) {
      throw new Error(
        `Qdrant collection ${this.collection} has vector size ${size}, expected ${KNOWLEDGE_VECTOR_SIZE}.`,
      );
    }

    for (const fieldName of ['domain', 'algorithmTag', 'contentType']) {
      try {
        await client.createPayloadIndex(this.collection, {
          field_name: fieldName,
          field_schema: 'keyword',
          wait: true,
        });
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    }
  }

  private async countRemote(): Promise<number> {
    const client = this.requireClient();
    const result = await client.count(this.collection, { exact: true });
    return result.count;
  }

  private async scrollPointIds(): Promise<string[]> {
    const client = this.requireClient();
    const ids: string[] = [];
    let offset: string | number | undefined;
    for (;;) {
      const page = await client.scroll(this.collection, {
        limit: 256,
        offset,
        with_payload: false,
        with_vector: false,
      });
      for (const point of page.points) {
        if (typeof point.id === 'string') ids.push(point.id);
      }
      const next = page.next_page_offset;
      if (typeof next !== 'string' && typeof next !== 'number') break;
      offset = next;
    }
    return ids;
  }
}

export async function openQdrantKnowledgeIndex(
  env: NodeJS.ProcessEnv = process.env,
): Promise<QdrantKnowledgeIndex> {
  return QdrantKnowledgeIndex.open(env);
}
