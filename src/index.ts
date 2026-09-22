export * from './types';
export * from './domain_classifier';
export * from './prompt_wrapping';
export * from './system_template_loader';
export * from './telemetry';
export * from './middleware';
export * from './learning';
export * from './components/AgentLogInspector';

import { NeuralCoreAdapter, WrappedPrompt, NeuralCoreResponse } from './types';

/**
 * Deterministic core adapter suitable for integration tests and local demos.
 * Production deployments should replace this with a real model endpoint.
 */
export class DeterministicCoreAdapter implements NeuralCoreAdapter {
  async execute(prompt: WrappedPrompt): Promise<NeuralCoreResponse> {
    return {
      coreNodeId: 'deterministic-core',
      output: [
        `system_prompt_length=${prompt.systemPrompt.length}`,
        `user_prompt_length=${prompt.userPrompt.length}`,
        `is_complex=${prompt.isComplex}`,
        `domain=${prompt.domain}`,
        `expected_accuracy=${prompt.expectedAccuracy}`,
      ].join(';'),
      latencyMs: 0,
      metadata: {
        urgencyBlockLength: prompt.urgencyBlock.length,
        politenessTier: prompt.politenessTier,
      },
    };
  }
}
