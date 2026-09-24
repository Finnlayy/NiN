import { useState, useMemo } from 'react';
import { Database, Image as ImageIcon, Search, ChevronRight, Maximize2, X, Terminal } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import TradingViewChart from './TradingViewChart';
import { generateOHLCData } from '../utils/mockData';

const HOUR_MS = 60 * 60 * 1000;

function ingestedHoursAgo(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * HOUR_MS).toISOString();
}

const VISION_ASSETS = [
  { id: 1, title: 'Wyckoff Accumulation Schema', category: 'Pattern Recognition', url: 'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?q=80&w=800&auto=format&fit=crop', hoursAgo: 6, confidence: 0.94 },
  { id: 2, title: 'Order Block Imbalance (L3)', category: 'Liquidity Analysis', url: 'https://images.unsplash.com/photo-1642543492481-44e81e3914a7?q=80&w=800&auto=format&fit=crop', hoursAgo: 30, confidence: 0.89 },
  { id: 3, title: 'Volume Profile Anomaly', category: 'Volume Metrics', url: 'https://images.unsplash.com/photo-1590283603385-18ff38584151?q=80&w=800&auto=format&fit=crop', hoursAgo: 54, confidence: 0.97 },
  { id: 4, title: 'Market Structure Break', category: 'Trend Analysis', url: 'https://images.unsplash.com/photo-1526628953301-3e589a6a8b74?q=80&w=800&auto=format&fit=crop', hoursAgo: 78, confidence: 0.91 },
] as const;

type VisionAsset = {
  id: number;
  title: string;
  category: string;
  url: string;
  timestamp: string;
  confidence: number;
};

interface KnowledgeLibProps {
  isAnalyzing: boolean;
  analysisResult: string | null;
  orderState: 'idle' | 'executing' | 'success';
  onAnalyze: () => void;
  onOrchestrateOrder: () => void;
  onCloseModal: () => void;
}

export default function KnowledgeLib({
  isAnalyzing,
  analysisResult,
  orderState,
  onAnalyze,
  onOrchestrateOrder,
  onCloseModal
}: KnowledgeLibProps) {
  const [selectedPhoto, setSelectedPhoto] = useState<VisionAsset | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Stamp ingestion times from now so the store stays current across sessions.
  const photos = useMemo<VisionAsset[]>(
    () =>
      VISION_ASSETS.map(({ hoursAgo, ...asset }) => ({
        ...asset,
        timestamp: ingestedHoursAgo(hoursAgo),
      })),
    [],
  );

  // Generate stable mock data for the chart
  const chartData = useMemo(() => generateOHLCData(120), []);

  const handleCloseModal = () => {
    setSelectedPhoto(null);
    onCloseModal();
  };

  const filteredPhotos = photos.filter(p => 
    p.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
    p.category.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="mt-8 bg-[#121620] border border-slate-800 rounded-xl overflow-hidden flex flex-col min-h-[400px]">
      <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-[#0a0c10]">
        <div className="flex items-center gap-3">
          <Database className="w-5 h-5 text-purple-400" />
          <h2 className="text-lg font-semibold text-white">Knowledge Lib: Vision Store</h2>
        </div>
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input 
            type="text" 
            placeholder="Search encoded photos..." 
            className="bg-[#1a1f2e] border border-slate-700 text-sm text-slate-200 rounded-md pl-9 pr-4 py-1.5 focus:outline-none focus:border-purple-500 transition-colors w-64"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {filteredPhotos.map((photo, idx) => (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.1 }}
            key={photo.id} 
            className="group relative bg-[#0a0c10] border border-slate-800 rounded-lg overflow-hidden cursor-pointer hover:border-purple-500/50 transition-colors"
            onClick={() => setSelectedPhoto(photo)}
          >
            <div className="aspect-video relative overflow-hidden bg-slate-900">
              <img 
                src={photo.url} 
                alt={photo.title} 
                className="w-full h-full object-cover opacity-60 group-hover:opacity-100 transition-opacity group-hover:scale-105 duration-500"
              />
              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/40 transition-opacity">
                <Maximize2 className="w-6 h-6 text-white" />
              </div>
            </div>
            <div className="p-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-purple-400">{photo.category}</span>
                <span className="text-[10px] font-mono text-emerald-400">{Math.round(photo.confidence * 100)}% Match</span>
              </div>
              <h4 className="text-sm font-medium text-slate-200 truncate">{photo.title}</h4>
              <p className="text-xs text-slate-500 mt-2 font-mono flex items-center gap-1">
                <ChevronRight className="w-3 h-3" />
                {new Date(photo.timestamp).toLocaleDateString()}
              </p>
            </div>
          </motion.div>
        ))}
        {filteredPhotos.length === 0 && (
          <div className="col-span-full py-12 flex flex-col items-center justify-center text-slate-500">
            <ImageIcon className="w-12 h-12 mb-3 opacity-20" />
            <p>No visual assets found in the current vector space.</p>
          </div>
        )}
      </div>

      {/* Lightbox Modal */}
      <AnimatePresence>
        {selectedPhoto && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
            onClick={handleCloseModal}
          >
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#121620] border border-slate-700 rounded-xl overflow-hidden max-w-5xl w-full flex flex-col shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex justify-between items-center p-4 border-b border-slate-800 bg-[#0a0c10]">
                <div>
                  <h3 className="text-lg font-bold text-white">{selectedPhoto.title}</h3>
                  <p className="text-xs text-slate-400 font-mono mt-1">UUID: {Math.random().toString(36).substring(2, 12).toUpperCase()} | CONFIDENCE: {selectedPhoto.confidence}</p>
                </div>
                <button onClick={handleCloseModal} className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-4 bg-[#0a0c10] border-b border-slate-800 flex items-center justify-between">
                <div className="flex gap-4">
                  <button 
                    onClick={onOrchestrateOrder}
                    disabled={orderState !== 'idle'}
                    className={`px-4 py-2 border rounded-lg text-sm font-semibold transition-colors flex items-center gap-2 ${
                      orderState === 'success' 
                        ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50' 
                        : orderState === 'executing'
                        ? 'bg-orange-500/10 text-orange-400 border-orange-500/50'
                        : 'bg-indigo-500/20 text-indigo-400 hover:bg-indigo-500/30 border-indigo-500/50'
                    }`}
                  >
                    {orderState === 'idle' && (
                      <>
                        <Terminal className="w-4 h-4" />
                        Orchestrate Kraken Pro Limit Order
                      </>
                    )}
                    {orderState === 'executing' && (
                      <>
                        <span className="w-4 h-4 rounded-full border-2 border-orange-400 border-t-transparent animate-spin" />
                        Executing via CLI...
                      </>
                    )}
                    {orderState === 'success' && (
                      <>
                        Order Filled & Confirmed
                      </>
                    )}
                  </button>
                </div>
              </div>
              <div className="p-1 bg-[#0a0c10] relative">
                <TradingViewChart 
                  data={chartData} 
                  highlightStartIndex={chartData.length - 40} 
                  highlightEndIndex={chartData.length - 10} 
                />
              </div>
              <div className="p-4 bg-[#0a0c10] border-t border-slate-800 flex items-center justify-between">
                 <div className="flex gap-4 items-center">
                   <div className="flex flex-col">
                     <span className="text-[10px] text-slate-500 uppercase font-bold">Category</span>
                     <span className="text-sm text-slate-300">{selectedPhoto.category}</span>
                   </div>
                   <div className="flex flex-col">
                     <span className="text-[10px] text-slate-500 uppercase font-bold">Ingestion Date</span>
                     <span className="text-sm text-slate-300">{new Date(selectedPhoto.timestamp).toLocaleString()}</span>
                   </div>
                   
                   {analysisResult && (
                     <div className="ml-4 px-3 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded text-emerald-400 text-xs font-mono animate-pulse">
                       {analysisResult}
                     </div>
                   )}
                 </div>
                 <button 
                   onClick={onAnalyze}
                   disabled={isAnalyzing}
                   className={`px-4 py-2 border rounded-lg text-xs font-semibold transition-colors flex items-center gap-2 ${
                     isAnalyzing 
                       ? 'bg-purple-500/10 text-purple-300 border-purple-500/20 cursor-not-allowed' 
                       : 'bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 border-purple-500/50'
                   }`}
                 >
                   {isAnalyzing ? (
                     <>
                       <span className="w-3 h-3 rounded-full border-2 border-purple-400 border-t-transparent animate-spin" />
                       Analyzing Vector Space...
                     </>
                   ) : (
                     'Run Secondary Analysis'
                   )}
                 </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
