import { createHash } from 'node:crypto';

export const RESEARCH_EVIDENCE_CONTRACT_VERSION = 1;
export const DESKTOP_RESEARCH_CAPABILITIES = Object.freeze([
  'supplied_documents',
  'public_web',
]);

const RELATIONS = new Set(['supports', 'conflicts', 'context']);
const DIRECTIONS = new Set(['consistent', 'inconsistent', 'neutral']);
const CLASSIFICATIONS = new Set([
  'supplied',
  'verified',
  'conflicting',
  'unavailable',
  'directional',
  'not_researchable',
]);
const RECEIPT_STATUSES = new Set([
  'completed',
  'unavailable',
  'ambiguous',
  'blocked',
  'failed',
  'skipped',
]);
const CONTINUATIONS = new Set([
  'not_applicable',
  'synthesis_without_observation',
  'run_failed',
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableId(prefix, value) {
  return `${prefix}-${createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16)}`;
}

function requiredString(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`Research evidence requires ${field}`);
  return normalized;
}

function optionalString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function finiteNonNegative(value, field, fallback = 0) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Research evidence ${field} must be a non-negative number`);
  }
  return number;
}

export function researchTaskId(questionId, capability) {
  return stableId('task', {
    questionId: requiredString(questionId, 'questionId'),
    capability: requiredString(capability, 'capability'),
  });
}

export function normalizeResearchTask(task, {
  desktopCapabilities = DESKTOP_RESEARCH_CAPABILITIES,
} = {}) {
  const questionId = requiredString(task?.questionId ?? task?.question_id, 'questionId');
  const capability = requiredString(task?.capability, 'capability');
  const required = Boolean(task?.required);
  if (required && !new Set(desktopCapabilities).has(capability)) {
    const error = new Error(`Credentialed-only capability cannot be required: ${capability}`);
    error.code = 'CREDENTIALED_CAPABILITY_REQUIRED';
    throw error;
  }
  return {
    taskId: optionalString(task?.taskId ?? task?.task_id) || researchTaskId(questionId, capability),
    questionId,
    targetClaimIds: Array.isArray(task?.targetClaimIds ?? task?.target_claim_ids)
      ? [...new Set((task.targetClaimIds ?? task.target_claim_ids).map(String))]
      : [],
    capability,
    required,
    maxCalls: finiteNonNegative(task?.maxCalls ?? task?.max_calls, 'maxCalls', 1),
    maxCostUsd: finiteNonNegative(task?.maxCostUsd ?? task?.max_cost_usd, 'maxCostUsd', 0),
    recencyRequirement: optionalString(task?.recencyRequirement ?? task?.recency_requirement),
    authorityRequirement: optionalString(task?.authorityRequirement ?? task?.authority_requirement),
    stopCondition: requiredString(task?.stopCondition ?? task?.stop_condition ?? 'Observation or explicit unavailable state recorded', 'stopCondition'),
  };
}

export function researchTasksFromPlan(plan) {
  return (plan?.questions || []).map(question => normalizeResearchTask({
    questionId: question.question_id,
    capability: 'public_web',
    required: Boolean(question.required),
    maxCalls: Math.max(1, Math.min(3, (question.search_queries || []).length || 1)),
    maxCostUsd: 0,
    recencyRequirement: question.recency_requirement,
    authorityRequirement: (question.preferred_sources || []).join('; ') || null,
    stopCondition: 'Observation or explicit unavailable state recorded',
  }));
}

export function normalizeEvidenceObservation(observation) {
  if (observation?.providerOpinion || observation?.provider_opinion) {
    const error = new Error('Provider opinion cannot enter the evidence packet');
    error.code = 'PROVIDER_OPINION_NOT_EVIDENCE';
    throw error;
  }
  const targetId = requiredString(observation?.targetId ?? observation?.target_id, 'targetId');
  const relation = requiredString(observation?.relation ?? 'context', 'relation');
  if (!RELATIONS.has(relation)) throw new Error(`Invalid evidence relation: ${relation}`);
  const isDerivedEstimate = Boolean(observation?.isDerivedEstimate ?? observation?.is_derived_estimate);
  const direction = optionalString(observation?.direction) || 'neutral';
  if (!DIRECTIONS.has(direction)) throw new Error(`Invalid evidence direction: ${direction}`);
  const classification = requiredString(
    observation?.classification ?? (isDerivedEstimate ? 'directional' : relation === 'conflicts' ? 'conflicting' : 'verified'),
    'classification',
  );
  if (!CLASSIFICATIONS.has(classification)) {
    throw new Error(`Invalid evidence classification: ${classification}`);
  }
  if ((isDerivedEstimate || classification === 'directional') && direction === 'neutral') {
    throw new Error('Directional evidence requires a consistent or inconsistent direction');
  }
  const normalized = {
    observationId: optionalString(observation?.observationId ?? observation?.observation_id),
    claimId: optionalString(observation?.claimId ?? observation?.claim_id),
    targetId,
    entity: observation?.entity || null,
    relation,
    direction,
    classification,
    sourceClass: requiredString(observation?.sourceClass ?? observation?.source_class ?? 'sdk_public_web', 'sourceClass'),
    authority: requiredString(observation?.authority ?? 'other', 'authority'),
    title: optionalString(observation?.title),
    publisher: optionalString(observation?.publisher),
    url: optionalString(observation?.url),
    publishedAt: optionalString(observation?.publishedAt ?? observation?.published_at),
    retrievedAt: optionalString(observation?.retrievedAt ?? observation?.retrieved_at) || new Date().toISOString(),
    fieldPath: optionalString(observation?.fieldPath ?? observation?.field_path),
    value: observation?.value,
    isDerivedEstimate,
  };
  normalized.observationId ||= stableId('observation', {
    targetId: normalized.targetId,
    relation: normalized.relation,
    sourceClass: normalized.sourceClass,
    url: normalized.url,
    fieldPath: normalized.fieldPath,
    value: normalized.value,
  });
  return normalized;
}

export function normalizeSourceReceipt(receipt) {
  const status = requiredString(receipt?.status, 'receipt status');
  if (!RECEIPT_STATUSES.has(status)) throw new Error(`Invalid source receipt status: ${status}`);
  const continuation = requiredString(
    receipt?.continuation ?? (status === 'completed' ? 'not_applicable' : 'synthesis_without_observation'),
    'receipt continuation',
  );
  if (!CONTINUATIONS.has(continuation)) {
    throw new Error(`Invalid source receipt continuation: ${continuation}`);
  }
  return {
    taskId: requiredString(receipt?.taskId ?? receipt?.task_id, 'receipt taskId'),
    sourceClass: requiredString(receipt?.sourceClass ?? receipt?.source_class, 'receipt sourceClass'),
    sourceId: optionalString(receipt?.sourceId ?? receipt?.source_id),
    status,
    disclosedMaxCostUsd: receipt?.disclosedMaxCostUsd ?? receipt?.disclosed_max_cost_usd ?? null,
    actualCostUsd: receipt?.actualCostUsd ?? receipt?.actual_cost_usd ?? null,
    durationMs: finiteNonNegative(receipt?.durationMs ?? receipt?.duration_ms, 'durationMs', 0),
    recordIds: Array.isArray(receipt?.recordIds ?? receipt?.record_ids)
      ? (receipt.recordIds ?? receipt.record_ids).map(String)
      : [],
    runIds: Array.isArray(receipt?.runIds ?? receipt?.run_ids)
      ? (receipt.runIds ?? receipt.run_ids).map(String)
      : [],
    continuation,
    errorCode: optionalString(receipt?.errorCode ?? receipt?.error_code),
  };
}

function classificationsFor(observations, questions) {
  return questions.map(question => {
    const matched = observations.filter(observation => observation.targetId === question.question_id);
    const status = matched.some(observation => observation.classification === 'conflicting')
      ? 'conflicting'
      : matched.some(observation => observation.classification === 'supplied')
        ? 'supplied'
        : matched.some(observation => observation.classification === 'verified')
          ? 'verified'
          : matched.some(observation => observation.classification === 'directional')
            ? 'directional'
            : 'unavailable';
    const directional = matched.find(observation => observation.classification === 'directional');
    return {
      targetId: question.question_id,
      status,
      direction: directional?.direction || 'neutral',
      observationIds: matched.map(observation => observation.observationId),
    };
  });
}

export function buildDecisionEvidencePacket({
  researchPlan,
  observations = [],
  criticalUnknowns = [],
  contradictions = [],
  teamDossier = '',
  companyContext = '',
  stopReason = 'required_questions_accounted_for',
}) {
  const normalizedObservations = observations.map(normalizeEvidenceObservation);
  const questions = researchPlan?.questions || [];
  const researchTasks = researchTasksFromPlan(researchPlan);
  const classifications = classificationsFor(normalizedObservations, questions);
  return {
    contractVersion: RESEARCH_EVIDENCE_CONTRACT_VERSION,
    observations: normalizedObservations,
    classifications,
    contradictions: contradictions.map(String),
    criticalUnknowns: criticalUnknowns.map(String),
    questionCoverage: classifications.map(item => ({
      questionId: item.targetId,
      required: Boolean(questions.find(question => question.question_id === item.targetId)?.required),
      status: item.status,
      observationIds: item.observationIds,
    })),
    researchPlan: researchTasks,
    teamDossier: String(teamDossier || ''),
    companyContext: String(companyContext || ''),
    stopReason: String(stopReason || ''),
  };
}

export function buildResearchRunEnvelope({
  productEdition = 'desktop',
  capabilities = DESKTOP_RESEARCH_CAPABILITIES,
  completedResearchPasses = [],
  sourceReceipts = [],
  decisionPacket,
}) {
  if (!['desktop', 'family_office'].includes(productEdition)) {
    throw new Error(`Invalid Radar product edition: ${productEdition}`);
  }
  if (!decisionPacket || decisionPacket.contractVersion !== RESEARCH_EVIDENCE_CONTRACT_VERSION) {
    throw new Error('Research run envelope requires a v1 decision packet');
  }
  const normalizedCapabilities = [...new Set(capabilities.map(String))].sort();
  const normalizedReceipts = sourceReceipts.map(normalizeSourceReceipt);
  return {
    contractVersion: RESEARCH_EVIDENCE_CONTRACT_VERSION,
    productEdition,
    toolRegistryFingerprint: stableId('registry', normalizedCapabilities),
    completedResearchPasses: [...completedResearchPasses],
    sourceReceipts: normalizedReceipts,
    decisionPacket,
  };
}

export function sourceReceiptsForTasks(tasks, observations, {
  sourceClass = 'sdk_public_web',
  durationMs = 0,
  actualCostUsd = null,
} = {}) {
  return tasks.map((task, index) => {
    const matched = observations.filter(observation => observation.targetId === task.questionId);
    return normalizeSourceReceipt({
      taskId: task.taskId,
      sourceClass,
      status: matched.length ? 'completed' : 'unavailable',
      actualCostUsd: index === 0 ? actualCostUsd : null,
      durationMs: index === 0 ? durationMs : 0,
      recordIds: matched.map(observation => observation.observationId),
      continuation: matched.length ? 'not_applicable' : 'synthesis_without_observation',
    });
  });
}
