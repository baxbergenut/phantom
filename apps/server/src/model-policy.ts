import type { ComplexityClass, ModelTier, QuotaUsageDelta, ReasoningLevel } from '@phantom/shared';

export interface CodexModelInfo {
  model: string;
  supportedReasoningEfforts: ReasoningLevel[];
}

export interface ModelCatalogProvider {
  listModels(): Promise<CodexModelInfo[]>;
}

export interface ModelTierSetting {
  model: string;
  reasoning: ReasoningLevel;
}

export type ModelPolicy = Record<ModelTier, ModelTierSetting>;

export const defaultModelPolicy: ModelPolicy = {
  economy: { model: 'gpt-5.6-luna', reasoning: 'medium' },
  standard: { model: 'gpt-5.6-terra', reasoning: 'high' },
  advanced: { model: 'gpt-5.6-sol', reasoning: 'high' },
  premium: { model: 'gpt-6-astra', reasoning: 'high' },
};

export class StaticModelCatalogProvider implements ModelCatalogProvider {
  constructor(private readonly policy: ModelPolicy = defaultModelPolicy) {}

  async listModels(): Promise<CodexModelInfo[]> {
    return Object.values(this.policy).map((setting) => ({
      model: setting.model,
      supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    }));
  }
}

export interface ModelSelection {
  tier: ModelTier;
  model: string;
  reasoning: ReasoningLevel;
  fallbackUsed: boolean;
  rationale: string;
}

const tierOrder: ModelTier[] = ['economy', 'standard', 'advanced', 'premium'];

export function resolveModelSelection(
  requestedTier: ModelTier,
  available: CodexModelInfo[],
  policy: ModelPolicy,
): ModelSelection | null {
  const requestedIndex = tierOrder.indexOf(requestedTier);
  for (const tier of tierOrder.slice(requestedIndex)) {
    const setting = policy[tier];
    const model = available.find((candidate) => candidate.model === setting.model);
    if (!model || !model.supportedReasoningEfforts.includes(setting.reasoning)) continue;
    const fallbackUsed = tier !== requestedTier;
    return {
      tier,
      model: setting.model,
      reasoning: setting.reasoning,
      fallbackUsed,
      rationale: fallbackUsed
        ? `${requestedTier} was unavailable; selected the next available non-downgrading tier ${tier}.`
        : `${requestedTier} mapped to ${setting.model} with ${setting.reasoning} reasoning and was reported available by Codex.`,
    };
  }
  return null;
}

export function modelPolicyFromEnvironment(): ModelPolicy {
  return {
    economy: settingFromEnvironment('ECONOMY', defaultModelPolicy.economy),
    standard: settingFromEnvironment('STANDARD', defaultModelPolicy.standard),
    advanced: settingFromEnvironment('ADVANCED', defaultModelPolicy.advanced),
    premium: settingFromEnvironment('PREMIUM', defaultModelPolicy.premium),
  };
}

export interface HistoricalExecutionSample {
  quotaUsageDelta: QuotaUsageDelta[] | null;
}

export interface QuotaEstimate {
  percent: number;
  source: 'baseline' | 'historical';
  sampleCount: number;
}

export function refineQuotaEstimate(
  baselinePercent: number,
  samples: HistoricalExecutionSample[],
  options: {
    minimumSamples?: number;
    percentile?: number;
    usableShortPercent?: number;
  } = {},
): QuotaEstimate {
  const minimumSamples = options.minimumSamples ?? 5;
  const percentile = options.percentile ?? 0.75;
  const usableShortPercent = options.usableShortPercent ?? 100;
  const values = samples
    .map((sample) => {
      const totals = new Map<string, number>();
      for (const delta of sample.quotaUsageDelta ?? []) {
        if (delta.kind !== 'short' || delta.usedPercentDelta < 0) continue;
        totals.set(delta.limitId, (totals.get(delta.limitId) ?? 0) + delta.usedPercentDelta);
      }
      const observed = [...totals.values()].filter(Number.isFinite);
      return observed.length ? (Math.max(...observed) * 100) / usableShortPercent : null;
    })
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((left, right) => left - right);
  if (values.length < minimumSamples) {
    return { percent: baselinePercent, source: 'baseline', sampleCount: values.length };
  }
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * percentile) - 1));
  const bounded = Math.min(
    Math.max(values[index]!, Math.max(1, baselinePercent * 0.5)),
    Math.min(80, baselinePercent * 1.5),
  );
  return {
    percent: Math.round(bounded * 10) / 10,
    source: 'historical',
    sampleCount: values.length,
  };
}

export function estimateHistoryKey(model: string, complexity: ComplexityClass): string {
  return `${model}:${complexity}`;
}

function settingFromEnvironment(suffix: string, fallback: ModelTierSetting): ModelTierSetting {
  const reasoning = process.env[`PHANTOM_MODEL_${suffix}_REASONING`];
  return {
    model: process.env[`PHANTOM_MODEL_${suffix}`] || fallback.model,
    reasoning: isReasoningLevel(reasoning) ? reasoning : fallback.reasoning,
  };
}

function isReasoningLevel(value: string | undefined): value is ReasoningLevel {
  return (
    value === 'none' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  );
}
