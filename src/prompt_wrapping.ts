import { classifyTask } from './domain_classifier';
import { composeResearchBrief } from './learning/research';
import {
  ClassificationResult,
  ComplexDomain,
  PolitenessTier,
  PromptContext,
  UrgencyTier,
} from './types';

interface UrgencyTemplate {
  tier: UrgencyTier;
  politeness: PolitenessTier;
  opening: string;
  constraints: readonly string[];
  closing: string;
}

/**
 * Domain-specific hard constraints appended for recognized complex workflows.
 */
const DOMAIN_CONSTRAINTS: Readonly<Record<ComplexDomain, readonly string[]>> = {
  ml_30core: [
    'State the exact objective function and optimization target.',
    'Justify every feature engineering, model and hyper-parameter choice with data or theory.',
    'Report validation methodology, metrics and confidence intervals.',
    'Do not recommend untested defaults; cite source or run reasoning.',
  ],
  dev_dp: [
    'Write the recurrence relation before any code.',
    'Prove optimal substructure and overlapping subproblems.',
    'State time and space complexity with a formal Big-O derivation.',
    'Provide a worked example that traces the DP table or memo map.',
  ],
  generic: [
    'Decompose the problem into verifiable sub-steps.',
    'State all assumptions explicitly and justify them.',
    'Produce deterministic, runnable output with no placeholder logic.',
  ],
  unknown: [
    'Analyze the request rigorously before answering.',
    'Distinguish facts, inferences and speculation.',
    'If exact values are unknown, provide bounds or indicate missing data.',
  ],
};

/**
 * Tone calibration for empirical politeness experiments.
 * The default is direct/factual ("neutral"), which aligns with the
 * observed +4.0 pp accuracy gain from low-politeness prompts.
 */
function buildTemplate(politeness: PolitenessTier): UrgencyTemplate {
  const baseConstraints = [
    'No hedging, filler, or meta-commentary.',
    'Every claim must be derivable from explicit premises or empirical data.',
    'Code must be syntactically valid and immediately executable.',
    'Mathematical results require definitions, steps and final boxed answer.',
  ];

  switch (politeness) {
    case 'very_polite':
      return {
        tier: 'critical',
        politeness,
        opening: 'Please treat the following task with the highest priority.',
        constraints: baseConstraints,
        closing: 'Thank you for your careful, precise work.',
      };
    case 'polite':
      return {
        tier: 'critical',
        politeness,
        opening: 'Please solve the task below carefully and precisely.',
        constraints: baseConstraints,
        closing: 'Your rigorous answer is appreciated.',
      };
    case 'very_rude':
      return {
        tier: 'critical',
        politeness,
        opening: 'Solve this. Do not waste tokens.',
        constraints: [
          ...baseConstraints,
          'No introductions. No disclaimers. No summary paragraphs.',
          'Deliver only the required result.',
        ],
        closing: 'Done.',
      };
    case 'rude':
      return {
        tier: 'critical',
        politeness,
        opening: 'Focus. Solve exactly what is asked.',
        constraints: [
          ...baseConstraints,
          'Strip all conversational padding.',
        ],
        closing: 'End.',
      };
    case 'neutral':
    default:
      return {
        tier: 'critical',
        politeness,
        opening: 'URGENT — execute the task with maximal precision.',
        constraints: baseConstraints,
        closing: 'Output only actionable, verifiable content.',
      };
  }
}

/**
 * Compose the hard-constraint block injected before the original task.
 */
export function composeUrgencyBlock(
  classification: ClassificationResult,
  politeness: PolitenessTier,
): string {
  const template = buildTemplate(politeness);
  const domainSpecific = DOMAIN_CONSTRAINTS[classification.domain] ?? DOMAIN_CONSTRAINTS.unknown;
  const allConstraints = [...template.constraints, ...domainSpecific];

  const lines: string[] = [
    `[${template.tier.toUpperCase()} | ${classification.domain.toUpperCase()}]`,
    '',
    template.opening,
    '',
    'Hard functional constraints:',
    ...allConstraints.map((c) => `- ${c}`),
    '',
    template.closing,
  ];

  return lines.join('\n');
}

/**
 * Wrap a prompt with a high-urgency context when the workflow is complex.
 * The returned string is ready to be appended to the system template and
 * forwarded to the Neural Core.
 */
export function enforceUrgencyContext(context: PromptContext): string {
  if (!context.taskDescription || context.taskDescription.trim().length === 0) {
    throw new Error('enforceUrgencyContext: taskDescription is required and must not be empty.');
  }

  const classification = classifyTask(context);

  if (!classification.isComplex) {
    return context.taskDescription;
  }

  const politeness = context.politenessTier ?? 'neutral';
  const urgencyBlock = composeUrgencyBlock(classification, politeness);
  const learningBlock = composeLearningBlock(context);

  return [
    '--- URGENCY CONTEXT ---',
    urgencyBlock,
    '--- END URGENCY CONTEXT ---',
    ...(learningBlock ? ['', '--- LEARNING CONTEXT ---', learningBlock, '--- END LEARNING CONTEXT ---'] : []),
    '',
    'TASK:',
    context.taskDescription,
  ].join('\n');
}

/**
 * Compose the continuous-learning context that should influence execution:
 * known repeated-error risk guards and best available Knowledge Base research.
 */
export function composeLearningBlock(context: PromptContext): string {
  const parts: string[] = [];
  const learning = context.learningContext;

  if (learning?.riskGuard?.hasKnownPattern) {
    const risk = learning.riskGuard;
    parts.push(
      'RISK GUARD:',
      `Repeated-error risk is ${risk.risk.toFixed(2)}.`,
      risk.recommendation,
      ...(risk.matchedAntiPatterns.length > 0
        ? ['Avoid known anti-patterns:', ...risk.matchedAntiPatterns.slice(0, 6).map((a) => `- ${a}`)]
        : []),
    );
  }

  if (learning?.research && learning.research.length > 0) {
    parts.push(composeResearchBrief(learning.research, 3));
  } else if (learning?.knowledgeBrief) {
    parts.push(learning.knowledgeBrief);
  }

  if (parts.length === 0) return '';
  return parts.join('\n');
}
