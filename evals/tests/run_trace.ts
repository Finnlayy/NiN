import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  DeterministicCoreAdapter,
  InMemoryTelemetryStore,
  MiddlewareConfig,
  PolitenessTier,
  processTask,
} from '../../src';

const ROOT = process.cwd();
const TEMPLATE_PATH = join(ROOT, 'prompts', 'system', 'neural_core.yaml');
const TRACE_PATH = join(ROOT, 'data', 'vectors', 'trace.json');

interface TraceCase {
  name: string;
  taskDescription: string;
  isComplexWorkflow: boolean;
  domainHint?: 'ml_30core' | 'dev_dp';
  algorithmTag?: string;
  politenessTier: PolitenessTier;
  observedAccuracy: number;
}

const cases: TraceCase[] = [
  {
    name: 'xgboost_transformer_selection',
    taskDescription:
      'Select between XGBoost and a Transformer architecture for a tabular sequence task.',
    isComplexWorkflow: true,
    domainHint: 'ml_30core',
    algorithmTag: 'transformer_selection',
    politenessTier: 'very_rude',
    observedAccuracy: 0.86,
  },
  {
    name: 'zero_one_knapsack',
    taskDescription:
      'Solve the 0/1 knapsack problem with dynamic programming, derive the recurrence and complexity.',
    isComplexWorkflow: true,
    domainHint: 'dev_dp',
    algorithmTag: 'knapsack_01',
    politenessTier: 'neutral',
    observedAccuracy: 0.83,
  },
  {
    name: 'dp_lcs_polite',
    taskDescription:
      'Compute the longest common subsequence using dynamic programming and prove correctness.',
    isComplexWorkflow: true,
    domainHint: 'dev_dp',
    algorithmTag: 'lcs',
    politenessTier: 'very_polite',
    observedAccuracy: 0.81,
  },
  {
    name: 'simple_greeting',
    taskDescription: 'Say hello to the team.',
    isComplexWorkflow: false,
    politenessTier: 'very_polite',
    observedAccuracy: 0.99,
  },
];

async function main(): Promise<void> {
  const telemetry = new InMemoryTelemetryStore();
  const coreAdapter = new DeterministicCoreAdapter();

  const config: MiddlewareConfig = {
    systemTemplatePath: TEMPLATE_PATH,
    complexityThreshold: 1,
    defaultPolitenessTier: 'neutral',
    telemetry,
    coreAdapter,
  };

  for (const testCase of cases) {
    const response = await processTask(
      {
        taskDescription: testCase.taskDescription,
        isComplexWorkflow: testCase.isComplexWorkflow,
        domainHint: testCase.domainHint,
        algorithmTag: testCase.algorithmTag,
        politenessTier: testCase.politenessTier,
      },
      config,
    );

    const lastEvent = telemetry.snapshot()[telemetry.snapshot().length - 1];
    if (lastEvent) {
      lastEvent.observedAccuracy = testCase.observedAccuracy;
    }

    // eslint-disable-next-line no-console
    console.log(`processed=${testCase.name} latencyMs=${response.latencyMs}`);
  }

  const trace = {
    generatedAt: new Date().toISOString(),
    events: telemetry.snapshot(),
    summary: telemetry.summarize(),
  };

  await mkdir(join(ROOT, 'data', 'vectors'), { recursive: true });
  await writeFile(TRACE_PATH, JSON.stringify(trace, null, 2), 'utf-8');
  console.log(`trace written to ${TRACE_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
