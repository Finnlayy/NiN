import { useState } from 'react';
import {
  X,
  Bot as BotIcon,
  AlertCircle
} from 'lucide-react';
import { TradingBot } from '../types';

interface CreateBotModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateBot: (botData: Partial<TradingBot> & { name: string; pair: string }) => Promise<void> | void;
}

const PRESET_PAIRS = [
  { pair: 'HYPE/USDT.P', venue: 'Pionex Futures', defaultPrice: 42.50, defaultRange: [39, 46], defaultLev: 75 },
  { pair: 'BTC/USD.P', venue: 'Kraken Pro Perpetual', defaultPrice: 64800, defaultRange: [61000, 69000], defaultLev: 10 },
  { pair: 'SOL/USD.P', venue: 'Kraken Pro Futures', defaultPrice: 142.50, defaultRange: [128, 158], defaultLev: 20 },
  { pair: 'ETH/USD.P', venue: 'Kraken Pro Perpetual', defaultPrice: 3450, defaultRange: [3200, 3750], defaultLev: 15 },
  { pair: 'SUI/USDT.P', venue: 'Pionex Futures', defaultPrice: 1.95, defaultRange: [1.70, 2.20], defaultLev: 50 },
];

export default function CreateBotModal({ isOpen, onClose, onCreateBot }: CreateBotModalProps) {
  const [name, setName] = useState('DCA Bot Beta');
  const [venue, setVenue] = useState('Pionex Futures');
  const [pair, setPair] = useState('HYPE/USDT.P');
  const [direction, setDirection] = useState<'LONG' | 'SHORT'>('LONG');
  const [strategy, setStrategy] = useState('PERPETUAL FUTURES · DCA STRATEGY');
  const [leverage, setLeverage] = useState<number>(75);
  const [investmentUsd, setInvestmentUsd] = useState<number>(50.0);
  const [entryPrice, setEntryPrice] = useState<number>(42.50);
  const [dcaRangeMin, setDcaRangeMin] = useState<number>(39);
  const [dcaRangeMax, setDcaRangeMax] = useState<number>(46);
  const [dcaLevels, setDcaLevels] = useState<number>(160);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSelectPreset = (preset: typeof PRESET_PAIRS[0]) => {
    setPair(preset.pair);
    setVenue(preset.venue);
    setEntryPrice(preset.defaultPrice);
    setDcaRangeMin(preset.defaultRange[0]);
    setDcaRangeMax(preset.defaultRange[1]);
    setLeverage(preset.defaultLev);
    setName(`${preset.pair.split('/')[0]} DCA Specialist`);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !pair.trim()) {
      setErrorMsg('Bitte Name und Handelspaar angeben.');
      return;
    }
    if (investmentUsd <= 0) {
      setErrorMsg('Investment muss größer als 0 sein.');
      return;
    }
    if (dcaRangeMin >= dcaRangeMax) {
      setErrorMsg('DCA Min Range muss kleiner als Max Range sein.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      await onCreateBot({
        name: name.trim(),
        venue,
        pair: pair.trim().toUpperCase(),
        direction,
        strategy,
        leverage,
        investmentUsd,
        entryPrice,
        currentPrice: entryPrice,
        dcaRangeMin,
        dcaRangeMax,
        dcaLevels,
      });
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md overflow-y-auto">
      <div className="relative w-full max-w-lg bg-[#0c101c] border border-slate-800 rounded-2xl shadow-2xl p-6 text-slate-200 my-8">
        {/* Top Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-purple-400">
              <BotIcon className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
                Neuen Trading-Bot erstellen
              </h2>
              <p className="text-xs text-slate-400">
                Erstelle eine neue Bot-Instanz mit individueller DCA-Matrix &amp; Telemetrie-Widget
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-slate-800/80 hover:bg-slate-700 flex items-center justify-center text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {errorMsg && (
          <div className="mt-4 p-3 bg-red-950/50 border border-red-500/50 rounded-xl text-red-300 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Quick Presets */}
        <div className="mt-4">
          <label className="text-[11px] font-mono uppercase tracking-wider text-slate-400 block mb-1.5">
            Schnell-Vorlagen:
          </label>
          <div className="flex flex-wrap gap-1.5">
            {PRESET_PAIRS.map((preset) => (
              <button
                key={preset.pair}
                type="button"
                onClick={() => handleSelectPreset(preset)}
                className={`px-2.5 py-1 rounded-lg text-xs font-mono font-medium border transition-colors ${
                  pair === preset.pair
                    ? 'bg-purple-500/20 border-purple-500/50 text-purple-300'
                    : 'bg-slate-800/50 border-slate-700/50 text-slate-300 hover:bg-slate-800'
                }`}
              >
                {preset.pair} ({preset.defaultLev}x)
              </button>
            ))}
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {/* Bot Name & Venue */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-300 block mb-1">
                Bot Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full px-3 py-2 bg-[#080c14] border border-slate-700/80 rounded-xl text-sm text-white focus:outline-none focus:border-purple-500 font-sans"
                placeholder="z.B. DCA Bot Gamma"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-slate-300 block mb-1">
                Börse / Plattform (Venue)
              </label>
              <select
                value={venue}
                onChange={(e) => setVenue(e.target.value)}
                className="w-full px-3 py-2 bg-[#080c14] border border-slate-700/80 rounded-xl text-sm text-white focus:outline-none focus:border-purple-500 font-sans"
              >
                <option value="Pionex Futures">Pionex Futures</option>
                <option value="Kraken Pro Perpetual">Kraken Pro Perpetual</option>
                <option value="Kraken Pro Spot">Kraken Pro Spot</option>
                <option value="Binance Futures">Binance Futures</option>
                <option value="Bybit Perpetual">Bybit Perpetual</option>
              </select>
            </div>
          </div>

          {/* Symbol & Direction & Leverage */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-300 block mb-1">
                Handelspaar (Pair)
              </label>
              <input
                type="text"
                value={pair}
                onChange={(e) => setPair(e.target.value)}
                required
                className="w-full px-3 py-2 bg-[#080c14] border border-slate-700/80 rounded-xl text-sm text-white focus:outline-none focus:border-purple-500 font-mono uppercase"
                placeholder="HYPE/USDT.P"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-slate-300 block mb-1">
                Richtung (Direction)
              </label>
              <div className="grid grid-cols-2 gap-1 bg-[#080c14] p-1 border border-slate-700/80 rounded-xl">
                <button
                  type="button"
                  onClick={() => setDirection('LONG')}
                  className={`py-1 rounded text-xs font-bold font-mono transition-colors ${
                    direction === 'LONG'
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  ▲ LONG
                </button>
                <button
                  type="button"
                  onClick={() => setDirection('SHORT')}
                  className={`py-1 rounded text-xs font-bold font-mono transition-colors ${
                    direction === 'SHORT'
                      ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  ▼ SHORT
                </button>
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-slate-300 block mb-1">
                Hebel (Leverage)
              </label>
              <select
                value={leverage}
                onChange={(e) => setLeverage(Number(e.target.value))}
                className="w-full px-3 py-2 bg-[#080c14] border border-slate-700/80 rounded-xl text-sm text-purple-300 font-bold font-mono focus:outline-none focus:border-purple-500"
              >
                <option value={1}>1x (Spot / Ohne Hebel)</option>
                <option value={3}>3x</option>
                <option value={5}>5x</option>
                <option value={10}>10x</option>
                <option value={20}>20x</option>
                <option value={50}>50x</option>
                <option value={75}>75x (Maximum)</option>
              </select>
            </div>
          </div>

          {/* Strategy Type */}
          <div>
            <label className="text-xs font-medium text-slate-300 block mb-1">
              Strategie-Klasse
            </label>
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
              className="w-full px-3 py-2 bg-[#080c14] border border-slate-700/80 rounded-xl text-sm text-white focus:outline-none focus:border-purple-500 font-sans"
            >
              <option value="PERPETUAL FUTURES · DCA STRATEGY">PERPETUAL FUTURES · DCA STRATEGY</option>
              <option value="SPOT ACCUMULATION · DYNAMIC DIP DCA">SPOT ACCUMULATION · DYNAMIC DIP DCA</option>
              <option value="VOLATILITY HARVEST · OMEGA GPM">VOLATILITY HARVEST · OMEGA GPM</option>
              <option value="ARBITRAGE GRID · CROSS-VENUE">ARBITRAGE GRID · CROSS-VENUE</option>
            </select>
          </div>

          {/* Investment & Entry Price */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-300 block mb-1">
                Investment Kapital (USD)
              </label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-slate-500 font-mono text-sm">$</span>
                <input
                  type="number"
                  step="any"
                  value={investmentUsd}
                  onChange={(e) => setInvestmentUsd(Number(e.target.value))}
                  required
                  min={1}
                  className="w-full pl-7 pr-3 py-2 bg-[#080c14] border border-slate-700/80 rounded-xl text-sm text-white font-mono focus:outline-none focus:border-purple-500"
                />
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-slate-300 block mb-1">
                Einstiegspreis (USD)
              </label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-slate-500 font-mono text-sm">$</span>
                <input
                  type="number"
                  step="any"
                  value={entryPrice}
                  onChange={(e) => setEntryPrice(Number(e.target.value))}
                  required
                  min={0.0001}
                  className="w-full pl-7 pr-3 py-2 bg-[#080c14] border border-slate-700/80 rounded-xl text-sm text-white font-mono focus:outline-none focus:border-purple-500"
                />
              </div>
            </div>
          </div>

          {/* DCA Range & Levels */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-300 block mb-1">
                DCA Min Preis
              </label>
              <input
                type="number"
                step="any"
                value={dcaRangeMin}
                onChange={(e) => setDcaRangeMin(Number(e.target.value))}
                required
                className="w-full px-3 py-2 bg-[#080c14] border border-slate-700/80 rounded-xl text-sm text-white font-mono focus:outline-none focus:border-purple-500"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-slate-300 block mb-1">
                DCA Max Preis
              </label>
              <input
                type="number"
                step="any"
                value={dcaRangeMax}
                onChange={(e) => setDcaRangeMax(Number(e.target.value))}
                required
                className="w-full px-3 py-2 bg-[#080c14] border border-slate-700/80 rounded-xl text-sm text-white font-mono focus:outline-none focus:border-purple-500"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-slate-300 block mb-1">
                DCA Stufen / Orders
              </label>
              <input
                type="number"
                value={dcaLevels}
                onChange={(e) => setDcaLevels(Number(e.target.value))}
                required
                min={2}
                max={500}
                className="w-full px-3 py-2 bg-[#080c14] border border-slate-700/80 rounded-xl text-sm text-white font-mono focus:outline-none focus:border-purple-500"
              />
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition-colors"
            >
              Abbrechen
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-5 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-purple-600/20 flex items-center gap-2 disabled:opacity-50"
            >
              <BotIcon className="w-4 h-4" />
              {isSubmitting ? 'Bot wird initialisiert...' : 'Bot starten & Widget anlegen'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
