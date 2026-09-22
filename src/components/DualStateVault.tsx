import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Wallet,
  Coins,
  ShieldCheck,
  TrendingUp,
  Percent,
  Layers,
  Sparkles,
  RotateCcw,
  Zap,
  Info,
  Clock,
  CheckCircle,
  Sliders
} from 'lucide-react';

export interface DualStateVaultProps {
  onLogEvent?: (message: string, level: 'info' | 'warn' | 'error' | 'success', node?: string) => void;
  className?: string;
  initialTotalAUM?: number;
  initialLeverage?: number;
}

export type VaultStateMode = 'STATE_A_AUTO_EARN' | 'STATE_B_FLASH_TWAP';
export type CurrencyUnit = 'USD' | 'EUR' | 'BTC';

interface TWAPSliceTelemetry {
  currentSlice: number;
  totalSlices: number;
  sliceAmountUSD: number;
  executedUSD: number;
  targetSymbol: string;
  vwapSlippagePercent: number;
  executionIntervalSec: number;
  isCompleted: boolean;
}

export default function DualStateVault({
  onLogEvent,
  className = '',
  initialTotalAUM = 100000.0,
  initialLeverage = 8.5,
}: DualStateVaultProps) {
  // AUM and Allocation State
  const [totalAUM, setTotalAUM] = useState<number>(initialTotalAUM);
  const [currency, setCurrency] = useState<CurrencyUnit>('USD');
  const [dynamicLeverage, setDynamicLeverage] = useState<number>(initialLeverage);
  const [vaultState, setVaultState] = useState<VaultStateMode>('STATE_A_AUTO_EARN');
  
  // Real-time Ticking and Accrual
  const [accruedYieldUSD, setAccruedYieldUSD] = useState<number>(14.285);
  const [marginRealizedPnL] = useState<number>(1240.50);
  const [marginUnrealizedPnL, setMarginUnrealizedPnL] = useState<number>(382.10);
  const [unbondingLatencyMs, setUnbondingLatencyMs] = useState<number>(23.8);
  const [isTransitioning, setIsTransitioning] = useState<boolean>(false);
  const [activeScenario, setActiveScenario] = useState<string>('CANONICAL');
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(false);

  // TWAP Execution Engine State (Zustand B)
  const [twapTelemetry, setTwapTelemetry] = useState<TWAPSliceTelemetry>({
    currentSlice: 6,
    totalSlices: 10,
    sliceAmountUSD: 1000.0,
    executedUSD: 6000.0,
    targetSymbol: 'SUI',
    vwapSlippagePercent: 0.018,
    executionIntervalSec: 3.0,
    isCompleted: false,
  });

  const isInitialMount = useRef(true);

  // Derived 90/10 Split Values
  const marginAllocationUSD = totalAUM * 0.9;
  const vaultAllocationUSD = totalAUM * 0.1;
  const effectivePurchasingPower = marginAllocationUSD * dynamicLeverage;

  // Currency Conversions
  const EUR_RATE = 0.92;
  const BTC_RATE = 0.0000154; // ~$64,900/BTC

  const formatCurrency = useCallback((valUSD: number, targetUnit: CurrencyUnit = currency): string => {
    if (targetUnit === 'EUR') {
      return `€${(valUSD * EUR_RATE).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    if (targetUnit === 'BTC') {
      return `₿${(valUSD * BTC_RATE).toFixed(4)}`;
    }
    return `$${valUSD.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }, [currency]);

  // Initial mount logging guard
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
  }, []);

  // Micro-Ticking Realtime Heartbeat
  useEffect(() => {
    const interval = setInterval(() => {
      // Auto-Earn yield tick (~7.25% APY on 10% vault = ~$725/year = ~$0.000023/sec)
      if (vaultState === 'STATE_A_AUTO_EARN') {
        setAccruedYieldUSD(prev => prev + 0.000023 * 2);
      }

      // Live micro-fluctuation in active margin positions PnL
      setMarginUnrealizedPnL(prev => {
        const delta = (Math.random() - 0.48) * 1.5;
        return Math.max(0, prev + delta);
      });

      // Update total AUM dynamically
      setTotalAUM(prev => {
        const microTick = (Math.random() - 0.49) * 0.4;
        return Number((prev + microTick).toFixed(2));
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [vaultState]);

  // TWAP execution ticker if in State B
  useEffect(() => {
    if (vaultState !== 'STATE_B_FLASH_TWAP' || twapTelemetry.isCompleted) return;

    const twapInterval = setInterval(() => {
      setTwapTelemetry(prev => {
        if (prev.currentSlice >= prev.totalSlices) {
          setTimeout(() => {
            onLogEvent?.(
              `[DUAL-VAULT §10] TWAP Execution abgeschlossen: 10/10 Tranchen à ${formatCurrency(prev.sliceAmountUSD)} auf ${prev.targetSymbol} vollständig gefüllt. Slippage: ${prev.vwapSlippagePercent}%`,
              'success',
              'TWAP_ENGINE'
            );
          }, 0);
          return { ...prev, isCompleted: true };
        }

        const nextSlice = prev.currentSlice + 1;
        const nextExecuted = nextSlice * prev.sliceAmountUSD;
        return {
          ...prev,
          currentSlice: nextSlice,
          executedUSD: nextExecuted,
          vwapSlippagePercent: +(0.015 + Math.random() * 0.008).toFixed(3),
        };
      });
    }, 3000);

    return () => clearInterval(twapInterval);
  }, [vaultState, twapTelemetry.isCompleted, onLogEvent, formatCurrency]);

  // Handle Switch between State A (Auto-Earn) and State B (Flash TWAP)
  const handleToggleVaultState = (targetState?: VaultStateMode) => {
    const nextState = targetState || (vaultState === 'STATE_A_AUTO_EARN' ? 'STATE_B_FLASH_TWAP' : 'STATE_A_AUTO_EARN');
    setIsTransitioning(true);

    // Simulate Instant-Unbonding latency (< 50ms SLA)
    const simulatedLatency = +(18 + Math.random() * 12).toFixed(1);
    setUnbondingLatencyMs(simulatedLatency);

    setTimeout(() => {
      setVaultState(nextState);
      setIsTransitioning(false);

      if (nextState === 'STATE_B_FLASH_TWAP') {
        // Reset TWAP engine
        setTwapTelemetry({
          currentSlice: 1,
          totalSlices: 10,
          sliceAmountUSD: vaultAllocationUSD / 10,
          executedUSD: vaultAllocationUSD / 10,
          targetSymbol: 'SUI',
          vwapSlippagePercent: 0.016,
          executionIntervalSec: 3.0,
          isCompleted: false,
        });

        setTimeout(() => {
          onLogEvent?.(
            `[DUAL-VAULT §10] Zustand B (Flash TWAP) aktiviert: Unbonding in ${simulatedLatency}ms ausgeführt. 10.0% Vault-Kapital (${formatCurrency(vaultAllocationUSD)}) für marktschonenden TWAP-Rebound freigegeben.`,
            'warn',
            'CAPITAL_ALLOCATOR'
          );
        }, 0);
      } else {
        setTimeout(() => {
          onLogEvent?.(
            `[DUAL-VAULT §10] Zustand A (Kraken Flexible Auto-Earn) re-engagiert: 10.0% Vault-Kapital (${formatCurrency(vaultAllocationUSD)}) generiert wieder 7.25% APY ohne Lock-up.`,
            'success',
            'CAPITAL_ALLOCATOR'
          );
        }, 0);
      }
    }, 45); // < 50ms transition
  };

  // Scenario Presets
  const handleSelectScenario = (preset: string) => {
    setActiveScenario(preset);

    if (preset === 'CANONICAL') {
      setTotalAUM(100000.0);
      setDynamicLeverage(8.5);
      setVaultState('STATE_A_AUTO_EARN');
      setTimeout(() => {
        onLogEvent?.(
          '[DUAL-VAULT §10] Szenario: Kanonische 90/10 Baseline aktiviert ($90k Margin @ 8.5x, $10k Auto-Earn @ 7.25% APY).',
          'info',
          'CAPITAL_ALLOCATOR'
        );
      }, 0);
    } else if (preset === 'GEOPOLITICAL_DIP') {
      setDynamicLeverage(10.0);
      handleToggleVaultState('STATE_B_FLASH_TWAP');
      setTimeout(() => {
        onLogEvent?.(
          '[DUAL-VAULT §10] Szenario: Geopolitischer Rebound / Flash-Discount (2:1 Deal) erkannt! Instant-Unbonding aktiv -> TWAP-Orderflow gestartet.',
          'warn',
          'THE_JUDGE'
        );
      }, 0);
    } else if (preset === 'GROUND_STATE') {
      setDynamicLeverage(1.0);
      setVaultState('STATE_A_AUTO_EARN');
      setTimeout(() => {
        onLogEvent?.(
          '[DUAL-VAULT §10] Szenario: Axiom 3 (Ground State) erzwungen! 100% Cash-Protection, alle Positionen via Cluster-Exit glattgestellt.',
          'success',
          'THE_JUDGE'
        );
      }, 0);
    } else if (preset === 'HIGH_BETA_SURGE') {
      setDynamicLeverage(15.0);
      setVaultState('STATE_A_AUTO_EARN');
      setTimeout(() => {
        onLogEvent?.(
          '[DUAL-VAULT §10] Szenario: High-Beta Impulse Surge! Konfidenz-Hebel auf 15.0x skaliert, maximale Einkaufskraft freigeschaltet.',
          'info',
          'CAPITAL_ALLOCATOR'
        );
      }, 0);
    }
  };

  return (
    <div
      id="dual-state-vault-container"
      className={`glass-card rounded-2xl p-6 shadow-2xl border border-white/10 relative overflow-hidden ${className}`}
    >
      {/* Background Quantum Gradient Glows */}
      <div className="absolute -top-24 -left-24 w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-24 -right-24 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />

      {/* Header with Title and Currency Toggle */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-white/5 relative z-10">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500/20 to-emerald-500/20 border border-cyan-500/40 flex items-center justify-center">
              <Wallet className="w-4 h-4 text-cyan-300" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white tracking-wide flex items-center gap-2">
                Kapital-Governance &amp; Dual-State Vault
                <span className="text-xs px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-mono font-medium">
                  §10 Blueprint
                </span>
              </h2>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                Rigorose 90/10 Kapitaltrennung • Active Margin vs. Flexible Auto-Earn • Instant Unbonding &lt; 50ms
              </p>
            </div>
          </div>
        </div>

        {/* Currency & Preset Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Currency Pill Switcher */}
          <div className="flex items-center bg-black/40 border border-white/10 rounded-xl p-1 text-xs font-mono">
            {(['USD', 'EUR', 'BTC'] as CurrencyUnit[]).map(curr => (
              <button
                key={curr}
                id={`currency-btn-${curr}`}
                onClick={() => setCurrency(curr)}
                className={`px-2.5 py-1 rounded-lg transition-all ${
                  currency === curr
                    ? 'bg-cyan-500/20 text-cyan-300 font-bold border border-cyan-500/40 shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {curr}
              </button>
            ))}
          </div>

          {/* Inspector Button */}
          <button
            id="open-vault-inspector-btn"
            onClick={() => setInspectorOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-mono text-slate-300 bg-white/5 hover:bg-white/10 border border-white/10 transition-all"
          >
            <Info className="w-3.5 h-3.5 text-cyan-400" />
            <span>§10 Spezifikation</span>
          </button>
        </div>
      </div>

      {/* SECTION 1: PROMINENT TOTAL AUM TICKER */}
      <div className="my-6 p-6 rounded-2xl bg-gradient-to-r from-slate-950/80 via-[#0c101c]/90 to-slate-950/80 border border-white/10 relative overflow-hidden">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
          {/* Main Ticker Display */}
          <div className="lg:col-span-6 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono tracking-wider uppercase text-slate-400 font-semibold flex items-center gap-1.5">
                <Coins className="w-3.5 h-3.5 text-emerald-400" /> Total AUM Ticker (Assets Under Management)
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-[10px] font-mono text-emerald-300">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                RECONCILED &lt; 24ms
              </span>
            </div>

            <div className="flex items-baseline gap-3">
              <p className="text-3xl md:text-4xl lg:text-5xl font-extrabold text-white font-mono tracking-tight">
                {formatCurrency(totalAUM)}
              </p>
              <span className="text-xs font-mono text-emerald-400 font-semibold flex items-center">
                <TrendingUp className="w-3.5 h-3.5 mr-1" />
                +$1,622.60 (+1.62% 24h)
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs font-mono text-slate-400 pt-1">
              <span>EUR Äquivalent: <strong className="text-slate-200">{formatCurrency(totalAUM, 'EUR')}</strong></span>
              <span>•</span>
              <span>BTC Äquivalent: <strong className="text-slate-200">{formatCurrency(totalAUM, 'BTC')}</strong></span>
              <span>•</span>
              <span>Kraken Accrued Yield: <strong className="text-emerald-400">+${accruedYieldUSD.toFixed(4)}</strong></span>
            </div>
          </div>

          {/* Quick Metrics Bar */}
          <div className="lg:col-span-6 grid grid-cols-2 sm:grid-cols-3 gap-3 font-mono">
            <div className="p-3 rounded-xl bg-white/[0.03] border border-white/5">
              <span className="text-[10px] uppercase text-slate-400 block">90% Margin Pool</span>
              <span className="text-sm md:text-base font-bold text-cyan-300 mt-0.5 block">
                {formatCurrency(marginAllocationUSD)}
              </span>
              <span className="text-[10px] text-slate-500">L_dyn: {dynamicLeverage}x</span>
            </div>

            <div className="p-3 rounded-xl bg-white/[0.03] border border-white/5">
              <span className="text-[10px] uppercase text-slate-400 block">10% Dual Vault</span>
              <span className="text-sm md:text-base font-bold text-emerald-400 mt-0.5 block">
                {formatCurrency(vaultAllocationUSD)}
              </span>
              <span className="text-[10px] text-emerald-500/90 font-medium">7.25% APY Yield</span>
            </div>

            <div className="p-3 rounded-xl bg-white/[0.03] border border-white/5 col-span-2 sm:col-span-1">
              <span className="text-[10px] uppercase text-slate-400 block">Unbonding SLA</span>
              <span className="text-sm md:text-base font-bold text-white mt-0.5 block flex items-center gap-1">
                <Zap className="w-3.5 h-3.5 text-amber-400" />
                {unbondingLatencyMs} ms
              </span>
              <span className="text-[10px] text-slate-500">Target &lt; 50 ms</span>
            </div>
          </div>
        </div>

        {/* Proportional 90 / 10 Allocation Bar */}
        <div className="mt-6 pt-5 border-t border-white/5">
          <div className="flex items-center justify-between text-xs font-mono mb-2">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-sm bg-cyan-500 shadow-sm shadow-cyan-500/50" />
              <span className="text-cyan-300 font-semibold">90.0 % Margin-Trading Pool</span>
              <span className="text-slate-400">({formatCurrency(marginAllocationUSD)})</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 shadow-sm shadow-emerald-500/50" />
              <span className="text-emerald-300 font-semibold">10.0 % Dual-State Vault</span>
              <span className="text-slate-400">({formatCurrency(vaultAllocationUSD)})</span>
            </div>
          </div>

          {/* Visual Track */}
          <div className="h-4 w-full bg-slate-900 rounded-full p-0.5 flex overflow-hidden border border-white/10 shadow-inner">
            <div
              className="h-full bg-gradient-to-r from-cyan-600 via-cyan-500 to-blue-500 rounded-l-full relative group transition-all duration-500 flex items-center justify-center"
              style={{ width: '90%' }}
            >
              <span className="text-[9px] font-mono text-black font-extrabold tracking-wider select-none">
                90% ACTIVE MARGIN
              </span>
            </div>
            <div
              className={`h-full rounded-r-full relative group transition-all duration-500 flex items-center justify-center ${
                vaultState === 'STATE_A_AUTO_EARN'
                  ? 'bg-gradient-to-r from-emerald-500 to-teal-400 animate-pulse'
                  : 'bg-gradient-to-r from-amber-500 to-orange-500'
              }`}
              style={{ width: '10%' }}
            >
              <span className="text-[9px] font-mono text-black font-extrabold tracking-wider select-none">
                10%
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* SECTION 2: DUAL CARDS (90% MARGIN POOL & 10% DUAL-STATE VAULT) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* LEFT COLUMN: 90% MARGIN-TRADING POOL */}
        <div className="lg:col-span-7 bg-[#0b0e17]/90 rounded-2xl p-5 border border-cyan-500/20 shadow-xl flex flex-col justify-between space-y-5">
          <div>
            {/* Card Header */}
            <div className="flex items-center justify-between pb-4 border-b border-white/5">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/30">
                  <TrendingUp className="w-5 h-5 text-cyan-400" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    90 % Margin-Trading Pool
                    <span className="text-[10px] px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-300 font-mono">
                      Alpha Engine
                    </span>
                  </h3>
                  <p className="text-[11px] text-slate-400 font-mono">
                    Aktives Pyramidisieren &amp; Dynamischer Konfidenz-Hebel
                  </p>
                </div>
              </div>

              <div className="text-right font-mono">
                <span className="text-[10px] uppercase text-slate-400 block">Pool Balance</span>
                <span className="text-lg font-bold text-cyan-300">{formatCurrency(marginAllocationUSD)}</span>
              </div>
            </div>

            {/* Dynamic Confidence Leverage Selector */}
            <div className="mt-4 p-4 rounded-xl bg-white/[0.02] border border-white/5 space-y-3 font-mono">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-cyan-400" />
                  <span className="text-xs text-slate-300 font-semibold">
                    Dynamischer Konfidenz-Hebel (L_dyn):
                  </span>
                </div>
                <span className="text-base font-bold text-cyan-300 px-2.5 py-0.5 rounded-lg bg-cyan-500/20 border border-cyan-500/40">
                  {dynamicLeverage.toFixed(1)}x
                </span>
              </div>

              {/* Slider */}
              <input
                id="dynamic-leverage-slider"
                type="range"
                min="1.0"
                max="20.0"
                step="0.5"
                value={dynamicLeverage}
                onChange={e => {
                  const val = parseFloat(e.target.value);
                  setDynamicLeverage(val);
                }}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
              />

              {/* Leverage Preset Buttons */}
              <div className="flex items-center justify-between text-[11px] pt-1">
                {[
                  { label: 'Defensiv 3x', val: 3.0 },
                  { label: 'Kanonisch 8.5x', val: 8.5 },
                  { label: 'Aggressiv 12x', val: 12.0 },
                  { label: 'Max Conviction 20x', val: 20.0 },
                ].map(item => (
                  <button
                    key={item.label}
                    id={`leverage-preset-${item.val}`}
                    onClick={() => {
                      setDynamicLeverage(item.val);
                      setTimeout(() => {
                        onLogEvent?.(
                          `[KAPITAL-GOVERNANCE] Konfidenz-Hebel auf ${item.val}x angepasst. Neue Einkaufskraft: ${formatCurrency(marginAllocationUSD * item.val)}`,
                          'info',
                          'M8_GATE'
                        );
                      }, 0);
                    }}
                    className={`px-2 py-1 rounded-lg transition-all ${
                      dynamicLeverage === item.val
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold'
                        : 'text-slate-400 hover:text-white bg-white/[0.02] border border-white/5'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Effective Purchasing Capacity & M8-Gate Metrics */}
            <div className="grid grid-cols-2 gap-3 mt-3 font-mono">
              <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
                <span className="text-[10px] text-slate-400 uppercase block">Einkaufskraft (Buying Power)</span>
                <span className="text-sm font-bold text-white mt-1 block">
                  {formatCurrency(effectivePurchasingPower)}
                </span>
                <span className="text-[10px] text-cyan-400/80 mt-1 block">
                  {marginAllocationUSD.toLocaleString()} × {dynamicLeverage}x
                </span>
              </div>

              <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
                <span className="text-[10px] text-slate-400 uppercase block">The Judge: M8-Gate Risiko</span>
                <span className="text-sm font-bold text-emerald-400 mt-1 block flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  0.00 $ Restrisiko
                </span>
                <span className="text-[10px] text-slate-400 mt-1 block">
                  Trailing Basket-Stop aktiv (Free-Roll)
                </span>
              </div>
            </div>

            {/* Active Tranches Mini Table */}
            <div className="mt-4 p-3 rounded-xl bg-black/40 border border-white/5 font-mono text-xs space-y-2">
              <span className="text-[10px] uppercase text-slate-400 font-semibold block">
                Aktive Pyramidisierungs-Tranchen
              </span>

              <div className="flex items-center justify-between py-1 border-b border-white/5 text-[11px]">
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                  <span className="font-bold text-white">SUI / USD Long</span>
                  <span className="text-slate-400">(Scout + 2 Add-Ons)</span>
                </div>
                <div className="text-right">
                  <span className="text-emerald-400 font-bold">+$480.20</span>
                  <span className="text-[10px] text-slate-500 ml-1">Unrealisiert</span>
                </div>
              </div>

              <div className="flex items-center justify-between py-1 border-b border-white/5 text-[11px]">
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                  <span className="font-bold text-white">SOL / USD Long</span>
                  <span className="text-slate-400">(Scout Tranche 1)</span>
                </div>
                <div className="text-right">
                  <span className="text-emerald-400 font-bold">+${marginUnrealizedPnL.toFixed(2)}</span>
                  <span className="text-[10px] text-slate-500 ml-1">Live Tick</span>
                </div>
              </div>

              <div className="flex items-center justify-between pt-1 text-[11px] border-t border-white/5 text-slate-400">
                <span>Historisch Realisierter Margin PnL:</span>
                <span className="text-white font-bold">+${marginRealizedPnL.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
              </div>
            </div>
          </div>

          <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-xs font-mono text-cyan-300 flex items-center justify-between">
            <span>Axiom 4: Maximale Risiko-Invarianz R_0 strikt eingehalten.</span>
            <CheckCircle className="w-4 h-4 text-cyan-400" />
          </div>
        </div>

        {/* RIGHT COLUMN: 10% DUAL-STATE VAULT (KRAKEN EARN / FLASH TWAP) */}
        <div
          className={`lg:col-span-5 rounded-2xl p-5 border shadow-xl flex flex-col justify-between space-y-5 transition-all duration-300 ${
            vaultState === 'STATE_A_AUTO_EARN'
              ? 'bg-[#0a1415]/90 border-emerald-500/30'
              : 'bg-[#18120b]/90 border-amber-500/40 shadow-amber-500/10'
          }`}
        >
          <div>
            {/* Card Header */}
            <div className="flex items-center justify-between pb-4 border-b border-white/5">
              <div className="flex items-center gap-2">
                <div
                  className={`p-2 rounded-xl border ${
                    vaultState === 'STATE_A_AUTO_EARN'
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                      : 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                  }`}
                >
                  <Coins className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    10 % Dual-State Vault
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded font-mono ${
                        vaultState === 'STATE_A_AUTO_EARN'
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'bg-amber-500/20 text-amber-300'
                      }`}
                    >
                      {vaultState === 'STATE_A_AUTO_EARN' ? 'State A' : 'State B'}
                    </span>
                  </h3>
                  <p className="text-[11px] text-slate-400 font-mono">
                    {vaultState === 'STATE_A_AUTO_EARN'
                      ? 'Kraken Flexible Auto-Earn'
                      : 'Dislocation Flash TWAP'}
                  </p>
                </div>
              </div>

              <div className="text-right font-mono">
                <span className="text-[10px] uppercase text-slate-400 block">Vault Balance</span>
                <span
                  className={`text-lg font-bold ${
                    vaultState === 'STATE_A_AUTO_EARN' ? 'text-emerald-400' : 'text-amber-400'
                  }`}
                >
                  {formatCurrency(vaultAllocationUSD)}
                </span>
              </div>
            </div>

            {/* Interactive State Toggle Buttons */}
            <div className="mt-4 p-1 rounded-xl bg-black/50 border border-white/10 grid grid-cols-2 gap-1 font-mono text-xs">
              <button
                id="vault-state-a-btn"
                onClick={() => handleToggleVaultState('STATE_A_AUTO_EARN')}
                disabled={isTransitioning}
                className={`py-2 px-3 rounded-lg flex items-center justify-center gap-1.5 transition-all ${
                  vaultState === 'STATE_A_AUTO_EARN'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold shadow-md'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                <span>Zustand A (Earn)</span>
              </button>

              <button
                id="vault-state-b-btn"
                onClick={() => handleToggleVaultState('STATE_B_FLASH_TWAP')}
                disabled={isTransitioning}
                className={`py-2 px-3 rounded-lg flex items-center justify-center gap-1.5 transition-all ${
                  vaultState === 'STATE_B_FLASH_TWAP'
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold shadow-md'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Zap className="w-3.5 h-3.5 text-amber-400" />
                <span>Zustand B (TWAP)</span>
              </button>
            </div>

            {/* ZUSTAND A BODY (Flexible Auto-Earn) */}
            {vaultState === 'STATE_A_AUTO_EARN' && (
              <div className="mt-4 space-y-3 font-mono">
                <div className="p-4 rounded-xl bg-emerald-500/5 border border-emerald-500/20 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-300 flex items-center gap-1.5">
                      <Percent className="w-3.5 h-3.5 text-emerald-400" /> Kraken Flexible Yield:
                    </span>
                    <span className="text-sm font-bold text-emerald-300 px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/30">
                      7.25% APY
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-xs pt-1">
                    <span className="text-slate-400">Lock-up Periode:</span>
                    <span className="text-white font-bold">0 Sekunden (Strictly Flexible)</span>
                  </div>

                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">Instant Unbonding:</span>
                    <span className="text-emerald-400 font-bold">&lt; 50 ms (gemessen: {unbondingLatencyMs} ms)</span>
                  </div>
                </div>

                {/* Projected Earnings Breakdown */}
                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="p-2.5 rounded-xl bg-white/[0.02] border border-white/5">
                    <span className="text-[10px] text-slate-400 block">Pro Tag</span>
                    <span className="font-bold text-white mt-0.5 block">
                      ${((vaultAllocationUSD * 0.0725) / 365).toFixed(2)}
                    </span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-white/[0.02] border border-white/5">
                    <span className="text-[10px] text-slate-400 block">Pro Monat</span>
                    <span className="font-bold text-white mt-0.5 block">
                      ${((vaultAllocationUSD * 0.0725) / 12).toFixed(2)}
                    </span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-white/[0.02] border border-white/5">
                    <span className="text-[10px] text-slate-400 block">Pro Jahr</span>
                    <span className="font-bold text-emerald-400 mt-0.5 block">
                      ${(vaultAllocationUSD * 0.0725).toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* ZUSTAND B BODY (Dislocation Flash TWAP) */}
            {vaultState === 'STATE_B_FLASH_TWAP' && (
              <div className="mt-4 space-y-3 font-mono">
                <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-amber-300 font-bold flex items-center gap-1.5">
                      <Zap className="w-3.5 h-3.5 text-amber-400" />
                      Flash TWAP Rebound Engine
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
                      {twapTelemetry.isCompleted ? 'ABGESCHLOSSEN' : 'AKTIV'}
                    </span>
                  </div>

                  <p className="text-[11px] text-slate-300">
                    Instant-Deallocation für geopolitischen Rebound (2:1 Flash Discount Deal auf {twapTelemetry.targetSymbol}).
                  </p>

                  {/* TWAP Progress */}
                  <div className="space-y-1.5 pt-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-400">Order Tranchen Ausführung:</span>
                      <span className="text-amber-300 font-bold">
                        {twapTelemetry.currentSlice} / {twapTelemetry.totalSlices} Slices
                      </span>
                    </div>

                    <div className="h-2 w-full bg-black/60 rounded-full overflow-hidden border border-white/5">
                      <div
                        className="h-full bg-gradient-to-r from-amber-500 to-orange-400 transition-all duration-300"
                        style={{ width: `${(twapTelemetry.currentSlice / twapTelemetry.totalSlices) * 100}%` }}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 pt-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Ausgeführt:</span>
                      <span className="text-white font-bold">{formatCurrency(twapTelemetry.executedUSD)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">VWAP Slippage:</span>
                      <span className="text-emerald-400 font-bold">{twapTelemetry.vwapSlippagePercent}%</span>
                    </div>
                  </div>
                </div>

                <button
                  id="revert-to-state-a-btn"
                  onClick={() => handleToggleVaultState('STATE_A_AUTO_EARN')}
                  className="w-full py-2 rounded-xl text-xs font-mono font-bold text-slate-300 bg-white/5 hover:bg-white/10 border border-white/10 transition-all flex items-center justify-center gap-1.5"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Revert zu Zustand A (Auto-Earn Re-Bond)</span>
                </button>
              </div>
            )}
          </div>

          {/* Card Footer SLA */}
          <div className="p-2.5 rounded-xl bg-white/[0.02] border border-white/5 text-xs font-mono text-slate-400 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              Unbonding Latenz: <strong className="text-white">{unbondingLatencyMs} ms</strong>
            </span>
            <span className="text-emerald-400 font-medium">Zero Lock-up</span>
          </div>
        </div>
      </div>

      {/* SECTION 3: SCENARIO PRESETS TOOLBAR */}
      <div className="mt-6 pt-5 border-t border-white/5 flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
        <div className="flex items-center gap-2 text-slate-400">
          <Layers className="w-4 h-4 text-cyan-400" />
          <span>Szenario-Simulationen (§10):</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {[
            { id: 'CANONICAL', label: 'Kanonische 90/10 Baseline' },
            { id: 'GEOPOLITICAL_DIP', label: '⚡ Geopolitischer Dip (State B TWAP)' },
            { id: 'GROUND_STATE', label: '🛡️ Ground State (100% Cash Safe Haven)' },
            { id: 'HIGH_BETA_SURGE', label: '🚀 High-Beta Surge (15x Leverage)' },
          ].map(sc => (
            <button
              key={sc.id}
              id={`vault-scenario-btn-${sc.id}`}
              onClick={() => handleSelectScenario(sc.id)}
              className={`px-3 py-1.5 rounded-xl border transition-all ${
                activeScenario === sc.id
                  ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 font-bold shadow-sm'
                  : 'bg-white/[0.02] hover:bg-white/[0.06] text-slate-400 hover:text-white border-white/5'
              }`}
            >
              {sc.label}
            </button>
          ))}
        </div>
      </div>

      {/* SECTION 4: §10 SPECIFICATION INSPECTOR MODAL */}
      {inspectorOpen && (
        <div
          id="vault-spec-modal"
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <div className="glass-card max-w-2xl w-full rounded-2xl p-6 border border-white/10 bg-[#0c101c] shadow-2xl font-mono text-xs space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-cyan-400" />
                <h3 className="text-base font-bold text-white">
                  §10 Kapital-Governance &amp; Dual-State Vault Spezifikation
                </h3>
              </div>
              <button
                id="close-vault-inspector-btn"
                onClick={() => setInspectorOpen(false)}
                className="text-slate-400 hover:text-white px-2 py-1 rounded bg-white/5"
              >
                ✕ Schließen
              </button>
            </div>

            <div className="space-y-3 text-slate-300 max-h-[70vh] overflow-y-auto pr-2">
              <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 space-y-1">
                <h4 className="text-cyan-300 font-bold">1. Die 90/10 Kapitaltrennung</h4>
                <p className="text-slate-400">
                  Um Alpha-Generierung mit maximalem Kapitalerhalt zu vereinen, allokiert The Judge
                  strikt 90 % in den aktiven Margin-Trading Pool und 10 % in die Dual-State Vault.
                </p>
              </div>

              <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 space-y-1">
                <h4 className="text-emerald-400 font-bold">2. Zustand A: Kraken Flexible Auto-Earn (Ruhephase)</h4>
                <p className="text-slate-400">
                  Das 10 % Vault-Kapital parkt ungebunden im Kraken Auto-Earn Protokoll mit 7.25% APY.
                  Es existieren keinerlei Lock-up Perioden.
                  Formel: Daily Yield = Vault USD &times; (0.0725 / 365)
                </p>
              </div>

              <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 space-y-1">
                <h4 className="text-amber-400 font-bold">3. Zustand B: Flash TWAP Dislocation (Aktion)</h4>
                <p className="text-slate-400">
                  Bei extremen Verwerfungen (geopolitische Schocks, 2:1 Flash Discounts) deallokiert
                  The Judge das Vault-Kapital in unter 50 ms (gemessen &lt; 24 ms) und führt eine
                  marktschonende Time-Weighted Average Price (TWAP) Order in $N=10$ Tranchen aus.
                </p>
              </div>

              <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 space-y-1">
                <h4 className="text-purple-300 font-bold">4. Axiom 3: Ground State Invarianz</h4>
                <p className="text-slate-400">
                  Sobald ein Cluster-Exit erfolgt oder destruktive Phasen-Interferenz detektiert wird,
                  fällt das Gesamtsystem in den Ground State zurück: 100 % Cash-Protection und Re-Bonding
                  in die Auto-Earn Zinsgenerierung.
                </p>
              </div>
            </div>

            <div className="pt-3 border-t border-white/10 flex justify-end">
              <button
                id="ack-vault-inspector-btn"
                onClick={() => setInspectorOpen(false)}
                className="px-4 py-2 rounded-xl bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold hover:bg-cyan-500/30 transition-all"
              >
                Verstanden &amp; Schließen
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
