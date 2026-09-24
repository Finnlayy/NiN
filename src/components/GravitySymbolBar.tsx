import type { GravitySummary, KrakenSymbol } from '../market/krakenLive';

interface GravitySymbolBarProps {
  catalog: KrakenSymbol[];
  selectedPair: string;
  calculating: boolean;
  calculatingAll: boolean;
  summaries: GravitySummary[];
  error: string | null;
  onSelect: (pair: string) => void;
  onCalculate: () => void;
  onCalculateAll: () => void;
}

export default function GravitySymbolBar({
  catalog,
  selectedPair,
  calculating,
  calculatingAll,
  summaries,
  error,
  onSelect,
  onCalculate,
  onCalculateAll,
}: GravitySymbolBarProps) {
  return (
    <div className="rounded-2xl border border-slate-700/80 bg-[#0d121f] p-4 space-y-3">
      <div className="flex flex-col lg:flex-row lg:items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-mono text-slate-400 flex-1" htmlFor="gravity-symbol">
          Symbol aus dem Kraken-Katalog
          <select
            id="gravity-symbol"
            value={selectedPair}
            onChange={(event) => onSelect(event.target.value)}
            className="bg-[#080d17] border border-slate-700 rounded-lg px-3 py-2 text-slate-200 text-sm focus:outline-none focus:border-cyan-500"
          >
            {catalog.length === 0 && <option value={selectedPair}>Katalog wird geladen…</option>}
            {catalog.map((symbol) => (
              <option key={symbol.pair} value={symbol.pair}>
                {symbol.display}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={onCalculate}
          disabled={calculating || catalog.length === 0}
          className="px-4 py-2 rounded-lg bg-cyan-600 text-white text-sm font-semibold disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          {calculating ? 'Berechnet…' : 'Berechnen'}
        </button>
        <button
          type="button"
          onClick={onCalculateAll}
          disabled={calculatingAll || catalog.length === 0}
          aria-label="Gravitation für alle Katalog-Symbole berechnen"
          className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-sm font-semibold disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          {calculatingAll ? 'Alle Symbole…' : 'Alle Symbole'}
        </button>
      </div>
      {error && (
        <p className="text-xs font-mono text-amber-300" role="status">{error}</p>
      )}
      {summaries.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[11px] font-mono text-slate-300">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1 pr-3">Symbol</th>
                <th className="py-1 pr-3">Last</th>
                <th className="py-1 pr-3">ATR14</th>
                <th className="py-1 pr-3">B lower</th>
                <th className="py-1 pr-3">B upper</th>
                <th className="py-1 pr-3">P*</th>
                <th className="py-1 pr-3">F net</th>
                <th className="py-1">Richtung</th>
              </tr>
            </thead>
            <tbody>
              {summaries.slice(0, 12).map((row) => (
                <tr key={row.pair} className="border-t border-slate-800">
                  <td className="py-1 pr-3">{row.display}</td>
                  <td className="py-1 pr-3">{row.last.toLocaleString()}</td>
                  <td className="py-1 pr-3">{row.atr14.toFixed(2)}</td>
                  <td className="py-1 pr-3">{row.bLower.toLocaleString()}</td>
                  <td className="py-1 pr-3">{row.bUpper.toLocaleString()}</td>
                  <td className="py-1 pr-3">{row.potentialMinimumPrice.toLocaleString()}</td>
                  <td className="py-1 pr-3">{row.forceNet}</td>
                  <td className="py-1">{row.direction}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {summaries.length > 12 && (
            <p className="text-[10px] text-slate-500 mt-1">{summaries.length} Symbole berechnet. Die Tabelle zeigt die ersten 12.</p>
          )}
        </div>
      )}
    </div>
  );
}
