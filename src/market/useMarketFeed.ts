import { useEffect, useState } from 'react';
import {
  calculateAllPairs,
  calculatePair,
  getMarketStore,
  quoteForDisplay,
  refreshWarmFeed,
  selectPair,
  selectedComputation,
  selectedTelemetry,
  subscribeMarket,
} from './krakenLive';

let pollers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

export function useMarketFeed() {
  const [, setTick] = useState(0);

  useEffect(() => {
    const unsubscribe = subscribeMarket(() => setTick((value) => value + 1));
    pollers += 1;
    if (!timer) {
      void refreshWarmFeed();
      timer = setInterval(() => {
        void refreshWarmFeed();
      }, 15000);
    }
    return () => {
      unsubscribe();
      pollers -= 1;
      if (pollers <= 0 && timer) {
        clearInterval(timer);
        timer = null;
        pollers = 0;
      }
    };
  }, []);

  const market = getMarketStore();
  return {
    feed: market.feed,
    selectedPair: market.selectedPair,
    computation: selectedComputation(),
    telemetry: selectedTelemetry(),
    summaries: market.summaries,
    calculating: market.calculating,
    calculatingAll: market.calculatingAll,
    error: market.error,
    quoteFor: (display: string) => quoteForDisplay(market.feed, display),
    selectPair: (pair: string) => selectPair(pair),
    calculate: (pair?: string) => calculatePair(pair ?? getMarketStore().selectedPair),
    calculateAll: () => calculateAllPairs(),
  };
}
