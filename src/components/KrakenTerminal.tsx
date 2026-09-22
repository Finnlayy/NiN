import React, { useState } from 'react';
import { Terminal, RefreshCw, AlertCircle, CheckCircle } from 'lucide-react';

export default function KrakenTerminal() {
  const [command, setCommand] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [result, setResult] = useState<any>(null);

  const handleExecute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!command.trim()) return;
    
    setIsExecuting(true);
    setResult(null);
    try {
      const res = await fetch('/api/execute-kraken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command })
      });
      const data = await res.json();
      setResult(data);
      setCommand('');
    } catch (err: any) {
      setResult({ success: false, error: err.message });
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <div className="bg-[#0a0c10] border-t border-slate-800 p-4 shrink-0 flex flex-col gap-3 font-mono text-xs">
      <div className="flex items-center gap-2 text-slate-300 font-semibold mb-1">
        <Terminal className="w-4 h-4 text-emerald-400" />
        <span className="uppercase tracking-wider text-[10px]">Kraken CLI Shell</span>
      </div>
      
      <form onSubmit={handleExecute} className="flex gap-2">
        <span className="text-blue-500 py-1.5 font-bold">kraken</span>
        <input 
          className="flex-1 bg-[#121620] border border-slate-700 text-slate-200 rounded px-3 py-1.5 outline-none focus:border-blue-500 font-mono" 
          value={command} 
          onChange={e => setCommand(e.target.value)}
          placeholder="e.g. status, assets, ticker XXBTZUSD, order create XXBTZUSD buy market 0.01"
          disabled={isExecuting}
        />
        <button 
          type="submit"
          disabled={isExecuting || !command.trim()}
          className="bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded px-4 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {isExecuting ? <RefreshCw className="w-3 h-3 animate-spin" /> : null}
          EXECUTE
        </button>
      </form>

      {result && (
        <div className={`mt-2 p-3 rounded border ${result.success === false || result.connected === false ? 'bg-red-500/10 border-red-500/20 text-red-400' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'} flex items-start gap-2 max-h-64 overflow-y-auto`}>
          {result.success === false || result.connected === false ? (
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          ) : (
            <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
          )}
          <div className="whitespace-pre-wrap font-mono text-[10px] leading-relaxed break-all">
            {JSON.stringify(result, null, 2)}
          </div>
        </div>
      )}
    </div>
  );
}
