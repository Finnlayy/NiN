import { motion, AnimatePresence } from 'framer-motion';
import { X, TrendingUp, TrendingDown, BarChart2, Activity, Globe } from 'lucide-react';

interface SentimentSidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SentimentSidebar({ isOpen, onClose }: SentimentSidebarProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed top-0 right-0 z-50 w-full max-w-sm h-full bg-[#0a0c10] border-l border-slate-800 shadow-2xl flex flex-col"
          >
            <div className="flex items-center justify-between p-5 border-b border-slate-800 bg-[#121620]">
              <div className="flex items-center gap-3">
                <Globe className="w-5 h-5 text-indigo-400" />
                <h2 className="text-lg font-semibold text-white">Sentiment Analysis</h2>
              </div>
              <button 
                onClick={onClose}
                className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-6">
              {/* Fear & Greed Index */}
              <div className="bg-[#121620] border border-slate-800 rounded-xl p-5">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                  <Activity className="w-4 h-4" /> Market Index
                </h3>
                <div className="flex flex-col items-center justify-center">
                  <div className="text-4xl font-bold text-emerald-400 mb-1">72</div>
                  <div className="text-sm text-emerald-400/80 font-medium">GREED</div>
                  
                  <div className="w-full h-2 bg-slate-800 rounded-full mt-4 overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-red-500 via-amber-500 to-emerald-500 w-[72%]" />
                  </div>
                  <div className="w-full flex justify-between text-[10px] text-slate-500 mt-2 font-mono">
                    <span>0 (Extreme Fear)</span>
                    <span>100 (Extreme Greed)</span>
                  </div>
                </div>
              </div>

              {/* Data Sources */}
              <div className="bg-[#121620] border border-slate-800 rounded-xl p-5">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                  <BarChart2 className="w-4 h-4" /> Social Firehose
                </h3>
                
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-blue-500" />
                      <span className="text-sm text-slate-300">X (Twitter) Vol</span>
                    </div>
                    <span className="text-sm font-mono text-white">+14.2k/hr</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-emerald-500" />
                      <span className="text-sm text-slate-300">Reddit Mentions</span>
                    </div>
                    <span className="text-sm font-mono text-white">+3.1k/hr</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-amber-500" />
                      <span className="text-sm text-slate-300">News Sentiment</span>
                    </div>
                    <span className="text-sm font-mono text-emerald-400">Bullish (0.84)</span>
                  </div>
                </div>
              </div>

              {/* Top Keywords */}
              <div className="bg-[#121620] border border-slate-800 rounded-xl p-5">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">Trending Vectors</h3>
                <div className="flex flex-wrap gap-2">
                  <span className="px-3 py-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-lg text-xs font-mono flex items-center gap-1">
                    <TrendingUp className="w-3 h-3" /> ETF Inflows
                  </span>
                  <span className="px-3 py-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-lg text-xs font-mono flex items-center gap-1">
                    <TrendingUp className="w-3 h-3" /> Breakout
                  </span>
                  <span className="px-3 py-1 bg-red-500/10 text-red-400 border border-red-500/20 rounded-lg text-xs font-mono flex items-center gap-1">
                    <TrendingDown className="w-3 h-3" /> Rate Hike
                  </span>
                  <span className="px-3 py-1 bg-slate-800 text-slate-300 border border-slate-700 rounded-lg text-xs font-mono">
                    Consolidation
                  </span>
                </div>
              </div>

            </div>
            
            <div className="p-5 border-t border-slate-800 bg-[#121620]">
              <button 
                className="w-full py-3 bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-400 border border-indigo-500/50 rounded-xl text-sm font-semibold transition-colors flex items-center justify-center gap-2"
              >
                Sync with NLP Model
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
