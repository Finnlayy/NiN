import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface TradingBot {
  id: string;
  name: string;
  venue: string;
  pair: string;
  strategy: string;
  direction: 'LONG' | 'SHORT';
  leverage: number;
  status: 'ACTIVE' | 'PAUSED' | 'STOPPED';
  
  // Pricing & PnL
  entryPrice: number;
  currentPrice: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPercent: number;
  
  // Financial metrics
  investmentUsd: number;
  investmentEur: number;
  realizedProfitUsd: number;
  realizedProfitLabel?: string;
  
  // Strategy metrics
  dcaRangeMin: number;
  dcaRangeMax: number;
  dcaLevels: number;
  dcaOrdersTriggered: number;
  
  // Fees & Risk
  fundingFeesUsd: number;
  liquidationPrice: number;
  liquidationDistancePercent: number;
  
  // Runtime & Cycles
  startedAt: string;
  runtimeDisplay: string;
  cycles: number;
  cycleProgressPercent: number;
  
  // Overall Summary
  totalProfitUsd: number;
  roiPercent: number;
  aprPercent: number;
  
  lastUpdated: string;
}

const STORAGE_PATH = join(process.cwd(), 'data', 'bots.json');

class BotRegistry {
  private bots: Map<string, TradingBot> = new Map();

  constructor() {
    this.loadBots();
  }

  private loadBots(): void {
    if (existsSync(STORAGE_PATH)) {
      try {
        const raw = readFileSync(STORAGE_PATH, 'utf-8');
        const list: TradingBot[] = JSON.parse(raw);
        for (const b of list) {
          this.bots.set(b.id, b);
        }
        return;
      } catch (e) {
        console.warn('[BotRegistry] Error loading saved bots, using default seeds:', e);
      }
    }

    // Default Seed Bots matching exact specifications & user's screenshot
    const defaultBots: TradingBot[] = [
      {
        id: 'BOT-7742',
        name: 'DCA Bot Alpha',
        venue: 'Pionex Futures',
        pair: 'HYPE/USDT.P',
        strategy: 'PERPETUAL FUTURES · DCA STRATEGY',
        direction: 'LONG',
        leverage: 75,
        status: 'ACTIVE',
        entryPrice: 41.250,
        currentPrice: 43.120,
        unrealizedPnlUsd: 12.84,
        unrealizedPnlPercent: 25.38,
        investmentUsd: 50.58,
        investmentEur: 45.00,
        realizedProfitUsd: 8.42,
        realizedProfitLabel: 'Realisiert (Zyklus)',
        dcaRangeMin: 39,
        dcaRangeMax: 44,
        dcaLevels: 160,
        dcaOrdersTriggered: 247,
        fundingFeesUsd: -1.14,
        liquidationPrice: 41.15,
        liquidationDistancePercent: -0.83,
        startedAt: new Date(Date.now() - 3.6 * 86400000).toISOString(),
        runtimeDisplay: '03d 14h 22m',
        cycles: 62,
        cycleProgressPercent: 62,
        totalProfitUsd: 21.26,
        roiPercent: 42.05,
        aprPercent: 4480,
        lastUpdated: new Date().toLocaleTimeString('de-DE')
      },
      {
        id: 'SWARM-L4',
        name: 'Swarm Limb 4 (BTC DCA)',
        venue: 'Kraken Pro Perpetual',
        pair: 'BTC/USD.P',
        strategy: 'PERPETUAL FUTURES · DYNAMIC DIP DCA',
        direction: 'LONG',
        leverage: 10,
        status: 'ACTIVE',
        entryPrice: 63850.00,
        currentPrice: 64920.50,
        unrealizedPnlUsd: 142.50,
        unrealizedPnlPercent: 18.25,
        investmentUsd: 750.00,
        investmentEur: 690.00,
        realizedProfitUsd: 84.60,
        realizedProfitLabel: 'Realisiert (Axiom 5)',
        dcaRangeMin: 60000,
        dcaRangeMax: 68000,
        dcaLevels: 24,
        dcaOrdersTriggered: 18,
        fundingFeesUsd: -4.30,
        liquidationPrice: 57460.00,
        liquidationDistancePercent: -11.45,
        startedAt: new Date(Date.now() - 5.2 * 86400000).toISOString(),
        runtimeDisplay: '05d 04h 11m',
        cycles: 28,
        cycleProgressPercent: 45,
        totalProfitUsd: 227.10,
        roiPercent: 30.28,
        aprPercent: 2120,
        lastUpdated: new Date().toLocaleTimeString('de-DE')
      },
      {
        id: 'SWARM-L5',
        name: 'Swarm Limb 5 (SOL DCA)',
        venue: 'Kraken Pro Futures',
        pair: 'SOL/USD.P',
        strategy: 'HIGH-BETA DIP ACCUMULATION',
        direction: 'LONG',
        leverage: 20,
        status: 'ACTIVE',
        entryPrice: 138.40,
        currentPrice: 145.80,
        unrealizedPnlUsd: 64.20,
        unrealizedPnlPercent: 32.10,
        investmentUsd: 200.00,
        investmentEur: 185.00,
        realizedProfitUsd: 41.80,
        realizedProfitLabel: 'Realisiert (Zyklus)',
        dcaRangeMin: 125,
        dcaRangeMax: 155,
        dcaLevels: 40,
        dcaOrdersTriggered: 32,
        fundingFeesUsd: -2.15,
        liquidationPrice: 131.50,
        liquidationDistancePercent: -9.80,
        startedAt: new Date(Date.now() - 2.8 * 86400000).toISOString(),
        runtimeDisplay: '02d 19h 45m',
        cycles: 44,
        cycleProgressPercent: 78,
        totalProfitUsd: 106.00,
        roiPercent: 53.00,
        aprPercent: 6890,
        lastUpdated: new Date().toLocaleTimeString('de-DE')
      },
      {
        id: 'BOT-SUI-01',
        name: 'SUI Momentum Runner',
        venue: 'Pionex Futures',
        pair: 'SUI/USDT.P',
        strategy: 'GPM ROTATION · VOLATILITY HARVEST',
        direction: 'LONG',
        leverage: 50,
        status: 'ACTIVE',
        entryPrice: 1.842,
        currentPrice: 1.984,
        unrealizedPnlUsd: 38.60,
        unrealizedPnlPercent: 77.20,
        investmentUsd: 50.00,
        investmentEur: 46.20,
        realizedProfitUsd: 19.40,
        realizedProfitLabel: 'Realisiert (GPM Delta-T)',
        dcaRangeMin: 1.70,
        dcaRangeMax: 2.10,
        dcaLevels: 80,
        dcaOrdersTriggered: 64,
        fundingFeesUsd: -0.85,
        liquidationPrice: 1.805,
        liquidationDistancePercent: -8.90,
        startedAt: new Date(Date.now() - 1.1 * 86400000).toISOString(),
        runtimeDisplay: '01d 02h 18m',
        cycles: 19,
        cycleProgressPercent: 35,
        totalProfitUsd: 58.00,
        roiPercent: 116.00,
        aprPercent: 9450,
        lastUpdated: new Date().toLocaleTimeString('de-DE')
      }
    ];

    for (const bot of defaultBots) {
      this.bots.set(bot.id, bot);
    }
    this.saveBots();
  }

  private saveBots(): void {
    try {
      const list = Array.from(this.bots.values());
      writeFileSync(STORAGE_PATH, JSON.stringify(list, null, 2), 'utf-8');
    } catch (e) {
      console.error('[BotRegistry] Failed to persist bots:', e);
    }
  }

  public getAll(): TradingBot[] {
    return Array.from(this.bots.values());
  }

  public getById(id: string): TradingBot | undefined {
    return this.bots.get(id);
  }

  public create(data: Partial<TradingBot> & { name: string; pair: string }): TradingBot {
    const randomId = 'BOT-' + Math.floor(1000 + Math.random() * 9000);
    const id = data.id || randomId;
    const direction = data.direction || 'LONG';
    const leverage = data.leverage || 10;
    const investmentUsd = Number(data.investmentUsd) || 100;
    const investmentEur = Number((investmentUsd * 0.92).toFixed(2));
    const entryPrice = Number(data.entryPrice) || (data.pair.includes('BTC') ? 64500 : data.pair.includes('SOL') ? 145 : data.pair.includes('HYPE') ? 42 : 2.5);
    const currentPrice = Number(data.currentPrice) || entryPrice;
    const dcaRangeMin = Number(data.dcaRangeMin) || Number((entryPrice * 0.9).toFixed(2));
    const dcaRangeMax = Number(data.dcaRangeMax) || Number((entryPrice * 1.1).toFixed(2));
    const dcaLevels = Number(data.dcaLevels) || 50;

    const bot: TradingBot = {
      id,
      name: data.name,
      venue: data.venue || 'Pionex Futures',
      pair: data.pair.toUpperCase(),
      strategy: data.strategy || 'PERPETUAL FUTURES · DCA STRATEGY',
      direction,
      leverage,
      status: 'ACTIVE',
      entryPrice,
      currentPrice,
      unrealizedPnlUsd: 0.00,
      unrealizedPnlPercent: 0.00,
      investmentUsd,
      investmentEur,
      realizedProfitUsd: 0.00,
      realizedProfitLabel: 'Realisiert (Zyklus)',
      dcaRangeMin,
      dcaRangeMax,
      dcaLevels,
      dcaOrdersTriggered: 1,
      fundingFeesUsd: 0.00,
      liquidationPrice: direction === 'LONG' 
        ? Number((entryPrice * (1 - 1 / leverage * 0.9)).toFixed(3))
        : Number((entryPrice * (1 + 1 / leverage * 0.9)).toFixed(3)),
      liquidationDistancePercent: Number((-100 / leverage * 0.9).toFixed(2)),
      startedAt: new Date().toISOString(),
      runtimeDisplay: '00d 00h 01m',
      cycles: 1,
      cycleProgressPercent: 5,
      totalProfitUsd: 0.00,
      roiPercent: 0.00,
      aprPercent: 0,
      lastUpdated: new Date().toLocaleTimeString('de-DE')
    };

    this.bots.set(id, bot);
    this.saveBots();
    return bot;
  }

  public update(id: string, updates: Partial<TradingBot>): TradingBot | null {
    const existing = this.bots.get(id);
    if (!existing) return null;

    const updated = {
      ...existing,
      ...updates,
      lastUpdated: new Date().toLocaleTimeString('de-DE')
    };
    this.bots.set(id, updated);
    this.saveBots();
    return updated;
  }

  public delete(id: string): boolean {
    const res = this.bots.delete(id);
    if (res) this.saveBots();
    return res;
  }

  public triggerCycle(id: string): TradingBot | null {
    const bot = this.bots.get(id);
    if (!bot || bot.status !== 'ACTIVE') return null;

    // Advance 1 cycle and calculate updated PnL
    const priceDeltaPercent = (Math.random() * 0.015 - 0.005);
    const newPrice = Number((bot.currentPrice * (1 + priceDeltaPercent)).toFixed(bot.currentPrice > 100 ? 2 : 4));
    const priceChange = (newPrice - bot.entryPrice) / bot.entryPrice;
    const directionMultiplier = bot.direction === 'LONG' ? 1 : -1;
    const unrealizedPercent = Number((priceChange * bot.leverage * directionMultiplier * 100).toFixed(2));
    const unrealizedUsd = Number(((bot.investmentUsd * unrealizedPercent) / 100).toFixed(2));
    
    // Increment cycle & orders
    const newCycles = bot.cycles + 1;
    const newOrders = bot.dcaOrdersTriggered + 1;
    const incrementalRealized = unrealizedUsd > 0 ? Number((unrealizedUsd * 0.25).toFixed(2)) : 0;
    const totalRealized = Number((bot.realizedProfitUsd + incrementalRealized).toFixed(2));
    const totalProfit = Number((totalRealized + unrealizedUsd).toFixed(2));
    const roi = Number(((totalProfit / bot.investmentUsd) * 100).toFixed(2));

    const updated: TradingBot = {
      ...bot,
      currentPrice: newPrice,
      unrealizedPnlUsd: unrealizedUsd,
      unrealizedPnlPercent: unrealizedPercent,
      realizedProfitUsd: totalRealized,
      dcaOrdersTriggered: newOrders,
      cycles: newCycles,
      cycleProgressPercent: (newCycles * 3) % 100,
      totalProfitUsd: totalProfit,
      roiPercent: roi,
      lastUpdated: new Date().toLocaleTimeString('de-DE')
    };

    this.bots.set(id, updated);
    this.saveBots();
    return updated;
  }
}

export const botRegistry = new BotRegistry();
