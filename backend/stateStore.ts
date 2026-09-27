import { Redis } from '@upstash/redis';

// ---------------------------------------------------------------------------
// Durable state layer (Upstash Redis via Vercel Marketplace).
//
// Vercel serverless functions get an ephemeral /tmp: every deploy and every
// fresh instance wipes order history, the Kraken paper-account journals and
// the DCA worker baseline. This module persists those three into Redis so
// they survive deploys and multi-instance routing.
//
// The layer is DORMANT until UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
// are set on the project (the Upstash integration injects them automatically):
// getRedis() returns null, reads return null and writes are no-ops, so local
// dev and un-provisioned deploys behave exactly as before.
// ---------------------------------------------------------------------------

let client: Redis | null | undefined;

export function getRedis(): Redis | null {
  if (client !== undefined) {
    return client;
  }
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  client = url && token ? new Redis({ url, token }) : null;
  return client;
}

/** True when a durable store is configured (surfaced in status payloads). */
export function isDurableStoreEnabled(): boolean {
  return getRedis() !== null;
}

/**
 * Read a JSON document. Returns null when the store is absent OR the read
 * fails — durability must never break the trading path.
 */
export async function getJson<T>(key: string): Promise<T | null> {
  const redis = getRedis();
  if (!redis) {
    return null;
  }
  try {
    return (await redis.get<T>(key)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist a JSON document, fire-and-forget: the caller never awaits and a
 * failing write never propagates. Concurrency note: last write wins, which is
 * acceptable for the small display/ledger state stored here.
 */
export function setJson(key: string, value: unknown): void {
  const redis = getRedis();
  if (!redis) {
    return;
  }
  try {
    void redis.set(key, value as never).catch(() => {});
  } catch {
    /* synchronous config errors are equally non-fatal */
  }
}
