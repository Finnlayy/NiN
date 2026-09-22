import { NeuralCoreAdapter, WrappedPrompt, NeuralCoreResponse } from '../src/types';
import { GeminiCoreAdapter } from './gemini';
import { LMStudioCoreAdapter, LMStudioConfig } from './lmStudio';
import { OneProviderCoreAdapter, OneProviderConfig } from './oneProvider';

export type AIProviderId = 'gemini' | 'lm_studio' | 'oneprovider';

export interface AIProviderInfo {
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

export class MultiProviderNeuralCore implements NeuralCoreAdapter {
  private activeProviderId: AIProviderId = 'gemini'; // Default: Gemini is active
  private geminiAdapter: GeminiCoreAdapter;
  private lmStudioAdapter: LMStudioCoreAdapter;
  private oneProviderAdapter: OneProviderCoreAdapter;

  constructor() {
    this.geminiAdapter = new GeminiCoreAdapter();
    this.lmStudioAdapter = new LMStudioCoreAdapter();
    this.oneProviderAdapter = new OneProviderCoreAdapter();
  }

  public getActiveProviderId(): AIProviderId {
    return this.activeProviderId;
  }

  public setActiveProviderId(id: AIProviderId): void {
    if (id !== 'gemini' && id !== 'lm_studio' && id !== 'oneprovider') {
      throw new Error(`Unknown AI provider: ${id}`);
    }
    this.activeProviderId = id;
  }

  public getLmStudioAdapter(): LMStudioCoreAdapter {
    return this.lmStudioAdapter;
  }

  public getOneProviderAdapter(): OneProviderCoreAdapter {
    return this.oneProviderAdapter;
  }

  public getProvidersInfo(): AIProviderInfo[] {
    return [
      {
        id: 'gemini',
        name: 'Google Gemini (Cloud)',
        badge: 'Cloud Orchestrator',
        description: 'Google DeepMind Antigravity Agent with Kraken function execution.',
        endpoint: 'https://generativelanguage.googleapis.com',
        model: 'antigravity-preview-05-2026',
        protocol: 'google-interactions',
        isActive: this.activeProviderId === 'gemini',
        status: this.activeProviderId === 'gemini' ? 'ACTIVE' : 'READY',
      },
      {
        id: 'lm_studio',
        name: 'LM Studio (Local Server)',
        badge: 'Local Offline AI',
        description: 'Private, zero-latency inference running on your local machine via OpenAI-compatible API.',
        endpoint: this.lmStudioAdapter.getBaseUrl(),
        model: this.lmStudioAdapter.getModel(),
        protocol: 'openai-compatible',
        isActive: this.activeProviderId === 'lm_studio',
        status: this.activeProviderId === 'lm_studio' ? 'ACTIVE' : 'READY',
      },
      {
        id: 'oneprovider',
        name: 'OneProvider Universal Gateway',
        badge: '3rd Option (Standby)',
        description: 'Anthropic-compatible unified gateway supporting claude-sonnet-4-6 and 83+ production models.',
        endpoint: this.oneProviderAdapter.getBaseUrl(),
        model: this.oneProviderAdapter.getModel(),
        protocol: 'anthropic-messages',
        isActive: this.activeProviderId === 'oneprovider',
        status: this.activeProviderId === 'oneprovider' ? 'ACTIVE' : 'STANDBY',
        isThirdOptionStandby: true,
      },
    ];
  }

  public updateLmStudioConfig(config: Partial<LMStudioConfig>): void {
    if (config.baseUrl) this.lmStudioAdapter.setBaseUrl(config.baseUrl);
    if (config.model) this.lmStudioAdapter.setModel(config.model);
  }

  public updateOneProviderConfig(config: Partial<OneProviderConfig>): void {
    if (config.baseUrl) this.oneProviderAdapter.setBaseUrl(config.baseUrl);
    if (config.model) this.oneProviderAdapter.setModel(config.model);
    if (config.apiKey !== undefined) this.oneProviderAdapter.setApiKey(config.apiKey);
    if (config.protocol) this.oneProviderAdapter.setProtocol(config.protocol);
  }

  public async testProvider(id: AIProviderId): Promise<{ ok: boolean; message: string; models?: string[] }> {
    if (id === 'lm_studio') {
      return this.lmStudioAdapter.testConnection();
    } else if (id === 'oneprovider') {
      return this.oneProviderAdapter.testConnection();
    } else {
      return {
        ok: true,
        message: 'Google Gemini / Antigravity Cloud adapter initialized and ready.',
      };
    }
  }

  public async execute(prompt: WrappedPrompt): Promise<NeuralCoreResponse> {
    switch (this.activeProviderId) {
      case 'lm_studio':
        return this.lmStudioAdapter.execute(prompt);
      case 'oneprovider':
        return this.oneProviderAdapter.execute(prompt);
      case 'gemini':
      default:
        return this.geminiAdapter.execute(prompt);
    }
  }
}

export const multiProviderCore = new MultiProviderNeuralCore();
