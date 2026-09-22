import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { InMemoryLearningStore } from './store';

/**
 * Persistence adapter for the learning store. Durable deployments can point
 * this at a database-backed implementation of the same interface.
 */
export interface LearningStoreProvider {
  load(): Promise<InMemoryLearningStore>;
  persist(store: InMemoryLearningStore): Promise<void>;
}

/** File-backed store provider that serializes the learning memory. */
export class FileLearningStoreProvider implements LearningStoreProvider {
  constructor(private readonly filePath: string) {}

  async load(): Promise<InMemoryLearningStore> {
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

  async persist(store: InMemoryLearningStore): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, store.toJSON(), 'utf-8');
  }
}

/** Convenience loader for a file-backed learning store. */
export async function loadLearningStore(filePath: string): Promise<InMemoryLearningStore> {
  const provider = new FileLearningStoreProvider(filePath);
  return provider.load();
}
