import { readFile } from 'fs/promises';
import YAML from 'yaml';
import { z } from 'zod';
import { SystemTemplate, UrgencyTier } from './types';

const urgencyTierSchema = z.enum(['low', 'normal', 'high', 'critical'] as const) as z.ZodType<UrgencyTier>;

const systemTemplateSchema = z.object({
  metadata: z.object({
    domain: z.string().min(1),
    node_id: z.string().min(1),
    urgency_tier: urgencyTierSchema,
    expected_accuracy: z.number().min(0).max(1),
    version: z.string().min(1),
    author: z.string().min(1),
  }),
  execution: z.object({
    preamble: z.string(),
    instruction: z.string(),
    urgency_injection_slot: z.string(),
    closing: z.string(),
  }),
});

/**
 * Load and validate the YAML system template at the given path.
 */
export async function loadSystemTemplate(filePath: string): Promise<SystemTemplate> {
  const raw = await readFile(filePath, 'utf-8');
  const parsed = YAML.parse(raw);
  const validated = systemTemplateSchema.parse(parsed);
  return validated as SystemTemplate;
}

/**
 * Render the final system prompt by injecting the urgency block into the
 * template slot. If no urgency block is provided, the slot is removed.
 */
export function renderSystemPrompt(
  template: SystemTemplate,
  urgencyBlock: string = '',
): string {
  const parts = [
    template.execution.preamble.trim(),
    template.execution.instruction.trim(),
    urgencyBlock.trim(),
    template.execution.closing.trim(),
  ].filter(Boolean);

  return parts.join('\n\n');
}
