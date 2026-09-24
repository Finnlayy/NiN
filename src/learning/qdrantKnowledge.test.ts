import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it } from 'node:test';
import { FileLearningStoreProvider } from './persistence';
import {
  knowledgeEntryFromPayload,
  knowledgePayload,
  knowledgePointId,
  knowledgeVector,
  KNOWLEDGE_VECTOR_SIZE,
  mergeKnowledgeEntries,
  type KnowledgeVectorHit,
  type KnowledgeVectorIndex,
  type KnowledgeVectorQuery,
  type QdrantKnowledgeStatus,
} from './qdrantKnowledge';
import { mergeResearchResults, researchFromVectorHits } from './research';
import { KnowledgeEntry } from './schemas';
import { InMemoryLearningStore } from './store';

function entry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: 'not-a-uuid',
    namespace: 'feedback',
    title: 'Corrected ml outcome',
    contentType: 'correction',
    domain: 'ml_30core',
    algorithmTag: 'xgboost',
    body: 'Use a gradient-boosted model with explicit categorical interaction terms.',
    tags: ['xgboost'],
    tokenIds: ['@@domain:ml_30core', '@@alg:xgboost', 'gradient', 'boost'],
    source: { kind: 'internal', ref: 'outcome-1' },
    evidence: [{ key: 'outcomeId', value: 'outcome-1' }],
    qualityScore: 0.7,
    createdAt: '2026-09-03T10:00:00.000Z',
    updatedAt: '2026-09-03T10:00:00.000Z',
    ...overrides,
  };
}

class MemoryIndex implements KnowledgeVectorIndex {
  entries: KnowledgeEntry[] = [];
  syncs: KnowledgeEntry[][] = [];
  mode: QdrantKnowledgeStatus['mode'] = 'qdrant';

  status(): QdrantKnowledgeStatus {
    return {
      mode: this.mode,
      collection: 'knowledge_library',
      vectorsStored: this.entries.length,
      url: 'http://qdrant.test',
    };
  }

  async loadAll(): Promise<KnowledgeEntry[]> {
    return this.entries.map((item) => ({ ...item }));
  }

  async sync(entries: readonly KnowledgeEntry[]): Promise<void> {
    this.syncs.push(entries.map((item) => ({ ...item })));
    this.entries = entries.map((item) => ({ ...item }));
  }

  async search(_query: KnowledgeVectorQuery): Promise<KnowledgeVectorHit[]> {
    return this.entries.map((item) => ({ entry: item, score: 0.8 }));
  }
}

describe('qdrant knowledge mapping', () => {
  it('hashes non-uuid ids into stable point ids', () => {
    const first = knowledgePointId('not-a-uuid');
    const second = knowledgePointId('not-a-uuid');
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const passthrough = '11111111-1111-4111-8111-111111111111';
    assert.equal(knowledgePointId(passthrough), passthrough);
  });

  it('builds a 64-d vector and round-trips the payload', () => {
    const source = entry();
    const vector = knowledgeVector(source);
    assert.equal(vector.length, KNOWLEDGE_VECTOR_SIZE);
    const restored = knowledgeEntryFromPayload(knowledgePayload(source));
    assert.deepEqual(restored, source);
    assert.equal(knowledgeEntryFromPayload({ id: 'x' }), null);
  });

  it('keeps the newer copy when merging the file snapshot with Qdrant', () => {
    const older = entry({ updatedAt: '2026-09-01T00:00:00.000Z', body: 'old' });
    const newer = entry({ updatedAt: '2026-09-04T00:00:00.000Z', body: 'new' });
    const remoteOnly = entry({ id: 'remote-only', title: 'remote' });
    const merged = mergeKnowledgeEntries([newer], [older, remoteOnly]);
    const byId = new Map(merged.map((item) => [item.id, item]));
    assert.equal(byId.get('not-a-uuid')?.body, 'new');
    assert.equal(byId.get('remote-only')?.title, 'remote');
  });
});

describe('file provider with a qdrant index', () => {
  it('hydrates knowledge from the index and syncs the union', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'knowledge-'));
    const filePath = join(dir, 'store.json');
    try {
      const seeded = new InMemoryLearningStore();
      seeded.upsertKnowledge(entry({ body: 'from-file', updatedAt: '2026-09-05T00:00:00.000Z' }));
      const seedProvider = new FileLearningStoreProvider(filePath);
      await seedProvider.persist(seeded);

      const index = new MemoryIndex();
      index.entries = [entry({ body: 'from-qdrant', updatedAt: '2026-09-01T00:00:00.000Z' })];
      const provider = new FileLearningStoreProvider(filePath, index);
      const loaded = await provider.load();
      assert.equal(loaded.listKnowledge()[0]?.body, 'from-file');
      assert.equal(index.entries[0]?.body, 'from-file');

      loaded.upsertKnowledge(entry({ id: 'second', title: 'second' }));
      await provider.persist(loaded);
      const raw = JSON.parse(await readFile(filePath, 'utf-8')) as { knowledge: KnowledgeEntry[] };
      assert.equal(raw.knowledge.length, 2);
      assert.equal(index.entries.length, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves the file snapshot alone when Qdrant is disconnected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'knowledge-'));
    const filePath = join(dir, 'store.json');
    try {
      const index = new MemoryIndex();
      index.mode = 'file_fallback';
      index.entries = [entry({ body: 'should-not-win' })];
      const provider = new FileLearningStoreProvider(filePath, index);
      const loaded = await provider.load();
      assert.equal(loaded.listKnowledge().length, 0);
      assert.equal(index.syncs.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('vector hit ranking', () => {
  it('merges a Qdrant hit with the local ranking by the higher score', () => {
    const known = entry();
    const remote = researchFromVectorHits(
      [{ entry: known, score: 0.95 }],
      ['gradient', 'boost'],
      { domain: 'ml_30core', algorithmTag: 'xgboost', limit: 5 },
    );
    assert.equal(remote.length, 1);
    assert.ok((remote[0]?.embeddingScore ?? 0) > 0.9);
    const merged = mergeResearchResults([[], remote], 5);
    assert.equal(merged[0]?.entry.id, known.id);
  });
});
