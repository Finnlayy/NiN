import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { KnowledgeVectorIndex, mergeKnowledgeEntries } from './qdrantKnowledge';
import { InMemoryLearningStore } from './store';

/**
 * Persistence adapter for the learning store. Durable deployments can point
 * this at a database-backed implementation of the same interface.
 */
export interface LearningStoreProvider {
  load(): Promise<InMemoryLearningStore>;
  persist(store: InMemoryLearningStore): Promise<void>;
}

/**
 * File-backed store provider that serializes the learning memory.
 * When a Qdrant index is connected, knowledge entries are synced to the
 * `knowledge_library` collection and reloaded from there on startup.
 */
export class FileLearningStoreProvider implements LearningStoreProvider {
  constructor(
    private readonly filePath: string,
    private readonly knowledgeIndex?: KnowledgeVectorIndex,
  ) {}

  async load(): Promise<InMemoryLearningStore> {
    const store = await this.readFileStore();
    const index = this.knowledgeIndex;
    if (!index || index.status().mode !== 'qdrant') return store;

    try {
      const remote = await index.loadAll();
      const merged = mergeKnowledgeEntries(store.listKnowledge(), remote);
      store.replaceKnowledge(merged);
      await index.sync(merged);
    } catch (error) {
      console.error('Failed to hydrate knowledge entries from Qdrant:', error);
    }
    return store;
  }

  async persist(store: InMemoryLearningStore): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, store.toJSON(), 'utf-8');
    const index = this.knowledgeIndex;
    if (!index || index.status().mode !== 'qdrant') return;
    try {
      await index.sync(store.listKnowledge());
    } catch (error) {
      console.error('Failed to sync knowledge entries to Qdrant:', error);
    }
  }

  private async readFileStore(): Promise<InMemoryLearningStore> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return InMemoryLearningStore.fromJSON(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new InMemoryLearningStore();
      }
      throw error;
    }
  }
}

/** Convenience loader for a file-backed learning store. */
export async function loadLearningStore(filePath: string): Promise<InMemoryLearningStore> {
  const provider = new FileLearningStoreProvider(filePath);
  return provider.load();
}
