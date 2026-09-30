import { NeuralCoreAdapter, WrappedPrompt, NeuralCoreResponse } from '../src/types';

export interface LMStudioConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export class LMStudioCoreAdapter implements NeuralCoreAdapter {
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;

  constructor(config?: Partial<LMStudioConfig>) {
    this.baseUrl = (config?.baseUrl || process.env.LM_STUDIO_BASE_URL || 'http://localhost:1234/v1').replace(/\/+$/, '');
    this.model = config?.model || process.env.LM_STUDIO_MODEL || 'local-model';
    this.timeoutMs = config?.timeoutMs || 60000;
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

  public async testConnection(): Promise<{ ok: boolean; message: string; models?: string[] }> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const endpoint = `${this.baseUrl}/models`;
      const res = await fetch(endpoint, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        return {
          ok: false,
          message: `LM Studio responded with HTTP ${res.status}: ${res.statusText}`,
        };
      }

      const data = await res.json() as { data?: Array<{ id: string }> };
      const modelIds = Array.isArray(data.data) ? data.data.map(m => m.id) : [];

      return {
        ok: true,
        message: `Connected to LM Studio at ${this.baseUrl}. Models loaded: ${modelIds.length > 0 ? modelIds.join(', ') : 'none detected'}.`,
        models: modelIds,
      };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return {
          ok: false,
          message: `Connection timed out after 5s connecting to ${this.baseUrl}. Is LM Studio server running?`,
        };
      }
      return {
        ok: false,
        message: `Could not connect to LM Studio at ${this.baseUrl}: ${err.message || 'Connection refused'}. Start the server in LM Studio on port 1234.`,
      };
    }
  }

  public async execute(prompt: WrappedPrompt): Promise<NeuralCoreResponse> {
    const start = Date.now();
    try {
      const messages: Array<{ role: string; content: string }> = [];

      // Add system prompt if available
      if (prompt.systemPrompt) {
        messages.push({
          role: 'system',
          content: `${prompt.systemPrompt}\n\nURGENCY LEVEL: ${prompt.urgencyBlock || 'NORMAL'}\nDOMAIN: ${prompt.domain || 'GENERAL'}`
        });
      }

      // Check if userPrompt is serialized conversation history
      let isHistoryParsed = false;
      try {
        const parsed = JSON.parse(prompt.userPrompt);
        if (Array.isArray(parsed) && parsed.length > 0) {
          for (const item of parsed) {
            if (item && typeof item === 'object' && item.role && item.content) {
              messages.push({
                role: item.role === 'system' ? 'system' : item.role === 'user' ? 'user' : 'assistant',
                content: String(item.content)
              });
            }
          }
          isHistoryParsed = true;
        }
      } catch {
        // Not JSON
      }

      if (!isHistoryParsed) {
        messages.push({
          role: 'user',
          content: prompt.userPrompt
        });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      const endpoint = `${this.baseUrl}/chat/completions`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.2,
          max_tokens: 2048,
          stream: false,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`LM Studio HTTP ${res.status} error: ${errText || res.statusText}`);
      }

      const json = await res.json() as any;
      const content = json.choices?.[0]?.message?.content || 'No output received from LM Studio.';
      const latencyMs = Date.now() - start;

      return {
        coreNodeId: 'lm-studio-local',
        output: content,
        latencyMs,
        metadata: {
          provider: 'lm_studio',
          endpoint: this.baseUrl,
          model: json.model || this.model,
          usage: json.usage,
          is_complex: prompt.isComplex,
        }
      };
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      const isAbort = err.name === 'AbortError';
      const errorMessage = isAbort
        ? `LM Studio request timed out after ${this.timeoutMs / 1000}s at ${this.baseUrl}.`
        : `LM Studio Execution Error (${this.baseUrl}): ${err.message}. Ensure LM Studio server is started.`;

      return {
        coreNodeId: 'lm-studio-local',
        output: errorMessage,
        latencyMs,
        metadata: {
          error: true,
          provider: 'lm_studio',
          endpoint: this.baseUrl,
          model: this.model,
        }
      };
    }
  }
}
