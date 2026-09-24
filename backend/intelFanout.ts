import { botRegistry } from './bots';
import { kernelEngine } from './kernel';
import { KrakenOrderExecutor } from './kraken';
import { engineTelemetryHub } from './telemetryEngine';
import type { GravitySummary } from '../src/market/krakenLive';

export function fanoutIntel(snapshots: GravitySummary[], kraken: KrakenOrderExecutor): void {
  const live = snapshots.filter((row) => row.last > 0);
  botRegistry.applyIntel(live);
  kraken.applyIntel(live);
  engineTelemetryHub.publishIntel(live);
  kernelEngine.applyIntel(live);
}
