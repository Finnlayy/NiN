import { GoogleGenAI } from '@google/genai';
import { NeuralCoreAdapter, WrappedPrompt, NeuralCoreResponse } from '../src/types';
import { KrakenOrderExecutor } from './kraken';

export class GeminiCoreAdapter implements NeuralCoreAdapter {
  private ai: GoogleGenAI | null = null;
  private kraken: KrakenOrderExecutor;

  constructor() {
    this.kraken = new KrakenOrderExecutor();
  }

  private geminiClient(): GoogleGenAI {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not set');
    }
    if (!this.ai) {
      this.ai = new GoogleGenAI({ apiKey });
    }
    return this.ai;
  }

  async execute(prompt: WrappedPrompt): Promise<NeuralCoreResponse> {
    const start = Date.now();
    if (!process.env.GEMINI_API_KEY) {
      return {
        coreNodeId: 'antigravity-orchestrator',
        output: 'Gemini API key is not configured. Set GEMINI_API_KEY, or switch the Neural Konsole engine to LM Studio.',
        latencyMs: Date.now() - start,
        metadata: { error: true },
      };
    }

    try {
      const ai = this.geminiClient();
      let finalMessage = prompt.userPrompt;
      
      try {
          const parsedHistory = JSON.parse(prompt.userPrompt);
          if (Array.isArray(parsedHistory) && parsedHistory.length > 0) {
             finalMessage = parsedHistory[parsedHistory.length - 1].content;
          }
      } catch {
          // not json, default to standard single turn
      }

      let interactionOpts: any = {
        agent: 'antigravity-preview-05-2026',
        environment: 'remote',
        background: true,
        input: finalMessage,
        config: {
          systemInstruction: prompt.systemPrompt,
          tools: [{
            functionDeclarations: [
              {
                name: 'execute_kraken_command',
                description: 'Execute a raw command against the kraken CLI. You can use any subcommand of kraken-cli.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    command_args: {
                      type: 'STRING',
                      description: 'The arguments to pass to kraken CLI, e.g. "status" or "ticker XXBTZUSD"'
                    }
                  },
                  required: ['command_args']
                }
              }
            ]
          }]
        }
      };

      if (prompt.previousInteractionId) {
        interactionOpts.previous_interaction_id = prompt.previousInteractionId;
      }

      let interaction: any = await ai.interactions.create(interactionOpts);

      // Poll until not in_progress
      while (interaction.status === 'in_progress') {
        await new Promise(resolve => setTimeout(resolve, 2000));
        interaction = await ai.interactions.get(interaction.id);
      }

      if (interaction.status === 'failed' || interaction.status === 'cancelled') {
         throw new Error(`Agent interaction ${interaction.status}`);
      }

      // Handle function calls
      while (interaction.status === 'completed' && this.hasFunctionCall(interaction)) {
         const toolCallStep: any = interaction.steps?.slice().reverse().find((s: any) => s.type === 'function_call');
         if (toolCallStep && toolCallStep.content) {
           for (const call of toolCallStep.content) {
             if (call.name === 'execute_kraken_command') {
                const args = call.args?.command_args;
                const result = await this.kraken.executeCommand(args);
                
                interaction = await ai.interactions.create({
                  agent: 'antigravity-preview-05-2026',
                  environment: 'remote',
                  background: true,
                  previous_interaction_id: interaction.id,
                  input: [{
                    functionResponse: {
                      name: 'execute_kraken_command',
                      response: result,
                      id: call.id
                    }
                  }] as any
                });

                // Poll again
                while (interaction.status === 'in_progress') {
                  await new Promise(resolve => setTimeout(resolve, 2000));
                  interaction = await ai.interactions.get(interaction.id);
                }
                
                if (interaction.status === 'failed' || interaction.status === 'cancelled') {
                   throw new Error(`Agent interaction ${interaction.status}`);
                }
             }
           }
         }
      }

      let fullOutput = "";
      if (interaction.steps) {
        for (const step of interaction.steps) {
          if (step.type === 'model_output') {
            const textContent: any = step.content?.find((c: any) => c.type === 'text');
            if (textContent && textContent.text) {
              fullOutput += String(textContent.text);
            }
          }
        }
      }

      return {
        coreNodeId: 'antigravity-orchestrator',
        output: fullOutput || "Directive executed successfully.",
        latencyMs: Date.now() - start,
        metadata: {
          model: 'antigravity-preview-05-2026',
          interactionId: interaction.id,
          is_complex: prompt.isComplex
        }
      };
    } catch (e: any) {
      return {
        coreNodeId: 'antigravity-orchestrator',
        output: `Execution Error: ${e.message}`,
        latencyMs: Date.now() - start,
        metadata: { error: true }
      };
    }
  }

  private hasFunctionCall(interaction: any): boolean {
     if (!interaction.steps) return false;
     const lastStep = interaction.steps[interaction.steps.length - 1];
     return lastStep.type === 'function_call';
  }
}
