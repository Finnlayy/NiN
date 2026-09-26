import { NeuralCoreAdapter, WrappedPrompt, NeuralCoreResponse } from '../src/types';
import { resolveBearerToken } from './connect';

export interface OneProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: 'anthropic-messages' | 'openai-compatible';
  timeoutMs: number;
}

/**
 * OneProvider Universal Gateway (https://api.oneprovider.dev)
 * Configured as the 3rd AI option (Standby / Inactive until activated).
 * Supports Anthropic-compatible protocol (claude-sonnet-4-6) or OpenAI API.
 */
export class OneProviderCoreAdapter implements NeuralCoreAdapter {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private protocol: 'anthropic-messages' | 'openai-compatible';
  private timeoutMs: number;
  private pinnedApiKey: boolean;

  constructor(config?: Partial<OneProviderConfig>) {
    this.baseUrl = (config?.baseUrl || process.env.ONEPROVIDER_BASE_URL || 'https://api.oneprovider.dev').replace(/\/+$/, '');
    this.apiKey = config?.apiKey || process.env.ONEPROVIDER_KEY || '';
    this.model = config?.model || process.env.ONEPROVIDER_MODEL || 'claude-sonnet-4-6';
    this.protocol = config?.protocol || 'anthropic-messages';
    this.timeoutMs = config?.timeoutMs || 60000;
    this.pinnedApiKey = config?.apiKey !== undefined;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, '');
  }

  public getModel(): string {
    return this.model;
  }

  public setModel(model: string): void {
    this.model = model;
  }

  public getApiKey(): string {
    return this.apiKey;
  }

  public setApiKey(key: string): void {
    this.apiKey = key;
    this.pinnedApiKey = true;
  }

  private async refreshCredential(): Promise<void> {
    if (this.pinnedApiKey) {
      return;
    }
    const token = await resolveBearerToken({
      connectorUid: process.env.CONNECT_ONEPROVIDER,
      fallback: process.env.ONEPROVIDER_KEY,
    });
    if (token !== undefined) {
      this.apiKey = token;
    }
  }

  public getProtocol(): 'anthropic-messages' | 'openai-compatible' {
    return this.protocol;
  }

  public setProtocol(protocol: 'anthropic-messages' | 'openai-compatible'): void {
    this.protocol = protocol;
  }

  public async testConnection(): Promise<{ ok: boolean; message: string }> {
    await this.refreshCredential();
    if (!this.apiKey) {
      return {
        ok: false,
        message: 'ONEPROVIDER_KEY is not configured yet. Add your key in settings or .env to activate.',
      };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);

      // Ping OneProvider health or models endpoint
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          message: `OneProvider authentication failed (HTTP ${res.status}). Verify your ONEPROVIDER_KEY.`,
        };
      }

      if (res.ok) {
        return {
          ok: true,
          message: `Connected to OneProvider Gateway (${this.baseUrl}) using model ${this.model}.`,
        };
      }

      return {
        ok: false,
        message: `OneProvider responded with HTTP ${res.status}: ${res.statusText}`,
      };
    } catch (err: any) {
      return {
        ok: false,
        message: `Could not reach OneProvider at ${this.baseUrl}: ${err.message}`,
      };
    }
  }

  public async execute(prompt: WrappedPrompt): Promise<NeuralCoreResponse> {
    const start = Date.now();
    await this.refreshCredential();

    if (!this.apiKey) {
      return {
        coreNodeId: 'oneprovider-gateway',
        output: 'OneProvider is currently on STANDBY. Please provide a valid ONEPROVIDER_KEY to activate this 3rd AI option.',
        latencyMs: 1,
        metadata: {
          error: true,
          provider: 'oneprovider',
          status: 'STANDBY_UNCONFIGURED',
          model: this.model,
        }
      };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      if (this.protocol === 'anthropic-messages') {
        // Format for Anthropic Messages API /v1/messages
        const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

        // Parse conversation history
        let isHistoryParsed = false;
        try {
          const parsed = JSON.parse(prompt.userPrompt);
          if (Array.isArray(parsed) && parsed.length > 0) {
            for (const item of parsed) {
              if (item && typeof item === 'object' && item.role && item.content) {
                // Anthropic messages API only accepts 'user' and 'assistant' roles in messages
                messages.push({
                  role: item.role === 'user' ? 'user' : 'assistant',
                  content: String(item.content)
                });
              }
            }
            isHistoryParsed = true;
          }
        } catch {
          // Single turn
        }

        if (!isHistoryParsed) {
          messages.push({
            role: 'user',
            content: prompt.userPrompt,
          });
        }

        const endpoint = `${this.baseUrl}/v1/messages`;
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: this.model,
            system: prompt.systemPrompt || 'You are The Judge & The Swarm neural orchestrator.',
            messages,
            max_tokens: 2048,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`OneProvider HTTP ${res.status}: ${errText || res.statusText}`);
        }

        const json = await res.json() as any;
        const textContent = json.content?.find((c: any) => c.type === 'text')?.text || 'No text response received from OneProvider.';

        return {
          coreNodeId: 'oneprovider-gateway',
          output: textContent,
          latencyMs: Date.now() - start,
          metadata: {
            provider: 'oneprovider',
            protocol: 'anthropic-messages',
            model: json.model || this.model,
            usage: json.usage,
            is_complex: prompt.isComplex,
          }
        };
      } else {
        // Standard OpenAI compatible format
        const messages: Array<{ role: string; content: string }> = [];
        if (prompt.systemPrompt) {
          messages.push({ role: 'system', content: prompt.systemPrompt });
        }
        messages.push({ role: 'user', content: prompt.userPrompt });

        const endpoint = `${this.baseUrl}/v1/chat/completions`;
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            max_tokens: 2048,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`OneProvider HTTP ${res.status}: ${errText || res.statusText}`);
        }

        const json = await res.json() as any;
        const output = json.choices?.[0]?.message?.content || 'No text output received from OneProvider.';

        return {
          coreNodeId: 'oneprovider-gateway',
          output,
          latencyMs: Date.now() - start,
          metadata: {
            provider: 'oneprovider',
            protocol: 'openai-compatible',
            model: json.model || this.model,
            usage: json.usage,
            is_complex: prompt.isComplex,
          }
        };
      }
    } catch (err: any) {
      return {
        coreNodeId: 'oneprovider-gateway',
        output: `OneProvider Execution Error: ${err.message}`,
        latencyMs: Date.now() - start,
        metadata: {
          error: true,
          provider: 'oneprovider',
          model: this.model,
          endpoint: this.baseUrl,
        }
      };
    }
  }
}
