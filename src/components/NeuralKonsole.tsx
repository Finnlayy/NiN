import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Terminal,
  Send,
  Command,
  Loader2,
  ChevronRight,
  Settings,
  Cpu,
  Laptop,
  Cloud,
  Check,
  AlertCircle,
  RefreshCw,
  ChevronUp
} from 'lucide-react';

export type AIProviderId = 'gemini' | 'lm_studio' | 'oneprovider';

export interface ProviderInfo {
  id: AIProviderId;
  name: string;
  badge: string;
  description: string;
  endpoint: string;
  model: string;
  protocol: string;
  isActive: boolean;
  status: 'ACTIVE' | 'STANDBY' | 'READY' | 'OFFLINE';
  isThirdOptionStandby?: boolean;
}

type Message = {
  id: string;
  role: 'user' | 'system';
  content: string;
  metadata?: any;
};

type TaskApiResponse = {
  output?: unknown;
  error?: unknown;
  latencyMs?: unknown;
  coreNodeId?: unknown;
  metadata?: {
    interactionId?: unknown;
    provider?: unknown;
    model?: unknown;
  };
};

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function readApiJson(res: Response): Promise<TaskApiResponse> {
  const raw = await res.text();
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('<')) {
    throw new Error('Neural core returned the web page instead of JSON. /api/task did not run.');
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Neural core returned an unexpected JSON shape.');
    }
    return parsed as TaskApiResponse;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error('Neural core returned an unreadable response.');
    }
    throw err;
  }
}

export default function NeuralKonsole() {
  const [interactionId, setInteractionId] = useState<string | undefined>();
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'system',
      content: 'M8-Gate Interactive Neural Konsole Online. Awaiting operator input...'
    }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Multi-Provider state
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<AIProviderId>('gemini');
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [isSwitchingProvider, setIsSwitchingProvider] = useState(false);
  const [testResult, setTestResult] = useState<{ providerId: AIProviderId; ok: boolean; message: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  // Editable config state
  const [lmBaseUrl, setLmBaseUrl] = useState('http://localhost:1234/v1');
  const [lmModel, setLmModel] = useState('local-model');
  const [oneProviderUrl, setOneProviderUrl] = useState('https://api.oneprovider.dev');
  const [oneProviderKey, setOneProviderKey] = useState('');
  const [oneProviderModel, setOneProviderModel] = useState('claude-sonnet-4-6');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const fetchProviders = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/providers');
      if (res.ok) {
        const data = await res.json();
        setProviders(data.providers || []);
        setActiveProviderId(data.activeProvider || 'gemini');

        const lm = (data.providers || []).find((p: ProviderInfo) => p.id === 'lm_studio');
        if (lm) {
          if (lm.endpoint) setLmBaseUrl(lm.endpoint);
          if (lm.model) setLmModel(lm.model);
        }

        const op = (data.providers || []).find((p: ProviderInfo) => p.id === 'oneprovider');
        if (op) {
          if (op.endpoint) setOneProviderUrl(op.endpoint);
          if (op.model) setOneProviderModel(op.model);
        }
      }
    } catch (err) {
      console.error('Error fetching AI providers:', err);
    }
  }, []);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  useEffect(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSelectProvider = async (providerId: AIProviderId) => {
    if (providerId === activeProviderId || isSwitchingProvider) return;
    setIsSwitchingProvider(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/ai/provider/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId })
      });
      if (res.ok) {
        const data = await res.json();
        setActiveProviderId(data.activeProvider);
        setProviders(data.providers);
        
        const selected = (data.providers as ProviderInfo[]).find(p => p.id === providerId);
        setMessages(prev => [
          ...prev,
          {
            id: Math.random().toString(36).substring(2),
            role: 'system',
            content: `Switched active neural engine to: ${selected?.name || providerId} (${selected?.model || 'default'}).`,
            metadata: { nodeId: providerId }
          }
        ]);
      }
    } catch (err: any) {
      console.error('Error switching provider:', err);
    } finally {
      setIsSwitchingProvider(false);
    }
  };

  const handleTestConnection = async (providerId: AIProviderId) => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/ai/provider/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId })
      });
      const data = await res.json();
      setTestResult({
        providerId,
        ok: !!data.ok,
        message: data.message || (data.ok ? 'Connection successful.' : 'Connection failed.')
      });
    } catch (err: any) {
      setTestResult({
        providerId,
        ok: false,
        message: `Network error: ${err.message}`
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSaveLmConfig = async () => {
    try {
      const res = await fetch('/api/ai/provider/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: 'lm_studio',
          config: { baseUrl: lmBaseUrl, model: lmModel }
        })
      });
      if (res.ok) {
        const data = await res.json();
        setProviders(data.providers);
        setSaveMessage('LM Studio config saved successfully.');
        setTimeout(() => setSaveMessage(null), 3000);
      }
    } catch (err: any) {
      setSaveMessage(`Save failed: ${err.message}`);
    }
  };

  const handleSaveOneProviderConfig = async () => {
    try {
      const res = await fetch('/api/ai/provider/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: 'oneprovider',
          config: {
            baseUrl: oneProviderUrl,
            apiKey: oneProviderKey,
            model: oneProviderModel,
            protocol: 'anthropic-messages'
          }
        })
      });
      if (res.ok) {
        const data = await res.json();
        setProviders(data.providers);
        setSaveMessage('OneProvider config saved.');
        setTimeout(() => setSaveMessage(null), 3000);
      }
    } catch (err: any) {
      setSaveMessage(`Save failed: ${err.message}`);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMsg: Message = {
      id: Math.random().toString(36).substring(2),
      role: 'user',
      content: input.trim()
    };
    
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setIsLoading(true);

    try {
      const historyPayload = newMessages.filter(m => m.id !== 'welcome').map(m => ({ role: m.role, content: m.content }));
      
      const res = await fetch('/api/task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskDescription: JSON.stringify(historyPayload),
          isComplexWorkflow: true,
          algorithmTag: 'operator_override',
          previousInteractionId: interactionId
        })
      });
      
      const data = await readApiJson(res);
      const interactionIdFromCore = asText(data.metadata?.interactionId);
      
      if (interactionIdFromCore) {
        setInteractionId(interactionIdFromCore);
      }
      
      setMessages(prev => [...prev, {
        id: Math.random().toString(36).substring(2),
        role: 'system',
        content: asText(data.output) || asText(data.error) || JSON.stringify(data),
        metadata: { 
          latency: typeof data.latencyMs === 'number' ? data.latencyMs : undefined, 
          nodeId: asText(data.coreNodeId),
          provider: asText(data.metadata?.provider),
          model: asText(data.metadata?.model),
          interactionId: interactionIdFromCore
        }
      }]);
    } catch (err: any) {
      setMessages(prev => [...prev, {
        id: Math.random().toString(36).substring(2),
        role: 'system',
        content: `Error connecting to core: ${err.message}`
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const activeProvider = providers.find(p => p.id === activeProviderId) || {
    id: 'gemini',
    name: 'Google Gemini (Cloud)',
    model: 'antigravity-preview-05-2026',
  };

  return (
    <div className="bg-[#0a0c10] border border-slate-800 rounded-xl flex flex-col overflow-hidden font-mono mt-6 shadow-xl">
      {/* Header with Provider Selector and Controls */}
      <div className="p-3 border-b border-slate-800 bg-[#121620] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Command className="w-4 h-4 text-blue-400" />
          <h3 className="text-xs font-semibold text-slate-300 tracking-wider uppercase">Neural Konsole</h3>
          <span className="text-slate-600">|</span>
          <div className="flex items-center gap-1 text-[11px]">
            <span className="text-slate-400">Engine:</span>
            <span className="font-bold text-cyan-300 flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping inline-block" />
              {activeProvider.name}
            </span>
            <span className="text-slate-500 font-mono text-[10px]">({activeProvider.model})</span>
          </div>
        </div>

        {/* Fast Provider Switcher Tabs */}
        <div className="flex items-center gap-1.5 bg-[#0a0d14] p-1 rounded-lg border border-slate-800 text-xs">
          {/* Option 1: Gemini */}
          <button
            onClick={() => handleSelectProvider('gemini')}
            disabled={isSwitchingProvider}
            className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-all flex items-center gap-1.5 ${
              activeProviderId === 'gemini'
                ? 'bg-blue-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <Cloud className="w-3 h-3" />
            Gemini Cloud
          </button>

          {/* Option 2: LM Studio */}
          <button
            onClick={() => handleSelectProvider('lm_studio')}
            disabled={isSwitchingProvider}
            className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-all flex items-center gap-1.5 ${
              activeProviderId === 'lm_studio'
                ? 'bg-emerald-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <Laptop className="w-3 h-3" />
            LM Studio (Local)
          </button>

          {/* Option 3: OneProvider (Standby / Inactive as requested) */}
          <button
            onClick={() => handleSelectProvider('oneprovider')}
            disabled={isSwitchingProvider}
            className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-all flex items-center gap-1.5 ${
              activeProviderId === 'oneprovider'
                ? 'bg-purple-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
            title="3rd Option: OneProvider Unified Gateway (Standby)"
          >
            <Cpu className="w-3 h-3 text-purple-400" />
            OneProvider
            <span className="px-1 py-0.2 bg-purple-500/20 text-purple-300 text-[9px] rounded border border-purple-500/30">
              3rd (Standby)
            </span>
          </button>

          {/* Settings Toggle */}
          <button
            onClick={() => setIsConfigOpen(prev => !prev)}
            className={`p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors ${
              isConfigOpen ? 'bg-slate-800 text-cyan-300' : ''
            }`}
            title="Configure AI Providers"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Config Drawer */}
      {isConfigOpen && (
        <div className="p-4 bg-[#0d121c] border-b border-slate-800 text-xs text-slate-300 space-y-4">
          <div className="flex items-center justify-between">
            <span className="font-bold text-white text-xs uppercase tracking-wider flex items-center gap-2">
              <Settings className="w-4 h-4 text-cyan-400" />
              AI Engines & Local Model Configuration
            </span>
            <button
              onClick={() => setIsConfigOpen(false)}
              className="text-slate-400 hover:text-white"
            >
              <ChevronUp className="w-4 h-4" />
            </button>
          </div>

          {saveMessage && (
            <div className="p-2 bg-emerald-500/10 border border-emerald-500/30 rounded text-emerald-300 text-[11px] flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5" />
              {saveMessage}
            </div>
          )}

          {testResult && (
            <div className={`p-2.5 rounded border text-[11px] flex items-start gap-2 ${
              testResult.ok
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
            }`}>
              {testResult.ok ? <Check className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
              <div>
                <strong className="uppercase font-mono">{testResult.providerId}:</strong> {testResult.message}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* LM Studio Configuration Box */}
            <div className="p-3 bg-[#080d14] border border-slate-800 rounded-xl space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-bold text-white">
                  <Laptop className="w-4 h-4 text-emerald-400" />
                  LM Studio (Local Host)
                </div>
                <span className="px-2 py-0.5 text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded">
                  OpenAI API Standard
                </span>
              </div>
              <p className="text-[11px] text-slate-400">
                Connects to your local machine (LM Studio Local Server). Start the server in LM Studio on port 1234.
              </p>

              <div className="space-y-1.5">
                <label className="text-[10px] text-slate-400 uppercase">Server Base URL</label>
                <input
                  type="text"
                  value={lmBaseUrl}
                  onChange={e => setLmBaseUrl(e.target.value)}
                  placeholder="http://localhost:1234/v1"
                  className="w-full bg-[#05070a] border border-slate-700 text-slate-200 rounded px-2.5 py-1.5 text-xs outline-none focus:border-emerald-500"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] text-slate-400 uppercase">Model Identifier</label>
                <input
                  type="text"
                  value={lmModel}
                  onChange={e => setLmModel(e.target.value)}
                  placeholder="local-model or qwen2.5-coder-32b"
                  className="w-full bg-[#05070a] border border-slate-700 text-slate-200 rounded px-2.5 py-1.5 text-xs outline-none focus:border-emerald-500"
                />
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={handleSaveLmConfig}
                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-bold text-xs transition-colors"
                >
                  Save Config
                </button>
                <button
                  onClick={() => handleTestConnection('lm_studio')}
                  disabled={isTesting}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 text-xs transition-colors flex items-center gap-1.5"
                >
                  <RefreshCw className={`w-3 h-3 ${isTesting ? 'animate-spin' : ''}`} />
                  Test Connection
                </button>
              </div>
            </div>

            {/* OneProvider Gateway Box (3rd Option) */}
            <div className="p-3 bg-[#080d14] border border-purple-500/30 rounded-xl space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-bold text-white">
                  <Cpu className="w-4 h-4 text-purple-400" />
                  OneProvider Gateway
                </div>
                <span className="px-2 py-0.5 text-[10px] bg-purple-500/20 text-purple-300 border border-purple-500/30 rounded font-bold">
                  3rd Option (Standby)
                </span>
              </div>
              <p className="text-[11px] text-slate-400">
                Unified Anthropic-messages gateway (<span className="text-purple-300">https://api.oneprovider.dev</span>). Prepared as requested but not active by default.
              </p>

              <div className="space-y-1.5">
                <label className="text-[10px] text-slate-400 uppercase">Endpoint URL</label>
                <input
                  type="text"
                  value={oneProviderUrl}
                  onChange={e => setOneProviderUrl(e.target.value)}
                  placeholder="https://api.oneprovider.dev"
                  className="w-full bg-[#05070a] border border-slate-700 text-slate-200 rounded px-2.5 py-1.5 text-xs outline-none focus:border-purple-500"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] text-slate-400 uppercase">Model (Claude Anthropic Protocol)</label>
                <input
                  type="text"
                  value={oneProviderModel}
                  onChange={e => setOneProviderModel(e.target.value)}
                  placeholder="claude-sonnet-4-6"
                  className="w-full bg-[#05070a] border border-slate-700 text-slate-200 rounded px-2.5 py-1.5 text-xs outline-none focus:border-purple-500 font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] text-slate-400 uppercase">ONEPROVIDER_KEY (Optional for Standby)</label>
                <input
                  type="password"
                  value={oneProviderKey}
                  onChange={e => setOneProviderKey(e.target.value)}
                  placeholder="Paste OneProvider key here when ready..."
                  className="w-full bg-[#05070a] border border-slate-700 text-slate-200 rounded px-2.5 py-1.5 text-xs outline-none focus:border-purple-500 font-mono"
                />
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={handleSaveOneProviderConfig}
                  className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded font-bold text-xs transition-colors"
                >
                  Save OneProvider
                </button>
                <button
                  onClick={() => handleTestConnection('oneprovider')}
                  disabled={isTesting}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 text-xs transition-colors flex items-center gap-1.5"
                >
                  <RefreshCw className={`w-3 h-3 ${isTesting ? 'animate-spin' : ''}`} />
                  Test Gateway
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Messages Feed */}
      <div 
        ref={messagesContainerRef}
        className="h-[320px] max-h-[320px] min-h-0 shrink-0 p-4 overflow-y-auto text-xs leading-relaxed flex flex-col gap-4 scrollbar-thin scrollbar-thumb-slate-700"
      >
        {messages.map(msg => (
          <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
            <div className={`max-w-[85%] rounded-lg p-3 ${
              msg.role === 'user' 
                ? 'bg-blue-600/20 border border-blue-500/30 text-blue-100' 
                : 'bg-[#121620] border border-slate-700 text-slate-300'
            }`}>
              {msg.role === 'system' && (
                <div className="flex items-center gap-2 mb-1.5 opacity-70">
                  <Terminal className="w-3 h-3" />
                  <span className="font-semibold text-[10px] tracking-wider text-emerald-400">SYSTEM RESPONSE</span>
                </div>
              )}
              <div className="whitespace-pre-wrap">{msg.content}</div>
              {msg.metadata && (
                <div className="mt-2 pt-2 border-t border-slate-700/50 flex flex-wrap gap-3 text-[10px] text-slate-500">
                  {msg.metadata.latency && <span>Latency: {msg.metadata.latency}ms</span>}
                  {msg.metadata.nodeId && <span>Engine: {msg.metadata.nodeId}</span>}
                  {msg.metadata.model && <span>Model: {msg.metadata.model}</span>}
                  {msg.metadata.interactionId && <span className="opacity-50">Chain: {msg.metadata.interactionId.substring(0, 8)}...</span>}
                </div>
              )}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex items-start">
            <div className="bg-[#121620] border border-slate-700 rounded-lg p-3 flex items-center gap-2 text-slate-400">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Generating directive with {activeProvider.name}...</span>
            </div>
          </div>
        )}
      </div>

      {/* Input Form */}
      <form onSubmit={handleSubmit} className="p-3 border-t border-slate-800 bg-[#121620] flex gap-2">
        <div className="relative flex-1">
          <ChevronRight className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            disabled={isLoading}
            placeholder={`Send directive to ${activeProvider.name}...`}
            className="w-full bg-[#0a0c10] border border-slate-700 text-slate-200 rounded pl-8 pr-4 py-2 outline-none focus:border-blue-500 transition-colors disabled:opacity-50 text-xs font-mono"
          />
        </div>
        <button
          type="submit"
          disabled={!input.trim() || isLoading}
          className="bg-blue-600 hover:bg-blue-500 text-white rounded px-4 py-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center min-w-[100px]"
        >
          {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
      </form>
    </div>
  );
}
