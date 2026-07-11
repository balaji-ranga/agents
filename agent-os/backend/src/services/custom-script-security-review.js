/**
 * Combined static + LLM security review for custom scripts.
 */
import { scanCustomScriptSource } from './custom-script-scanner.js';
import {
  isCustomScriptLlmReviewEnabled,
  reviewCustomScriptWithLlm,
  llmFindingsFromReview,
} from './custom-script-llm-reviewer.js';

const SEVERITY_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };

function maxRisk(a, b) {
  return (SEVERITY_ORDER[a] ?? 0) >= (SEVERITY_ORDER[b] ?? 0) ? a : b;
}

/**
 * Run regex static scan, then LLM certification (if enabled and static passed).
 */
export async function runCustomScriptSecurityReview({
  source,
  language = 'python',
  runtimeProfile = 'restricted',
  scriptName = '',
  skipLlm = false,
} = {}) {
  const static_scan = scanCustomScriptSource({ source, language, runtimeProfile });

  let llm_review = {
    enabled: false,
    certified: true,
    recommendation: 'approve',
    risk_level: 'low',
    summary: 'LLM review skipped — static scan failed',
    concerns: [],
    positive_signals: [],
    skipped: true,
    reviewed_at: new Date().toISOString(),
  };

  const runLlm = !skipLlm && isCustomScriptLlmReviewEnabled() && static_scan.passed;
  if (runLlm) {
    llm_review = await reviewCustomScriptWithLlm({
      source,
      language,
      runtimeProfile,
      staticFindings: static_scan.findings,
      scriptName,
    });
  } else if (!static_scan.passed) {
    llm_review.summary = 'LLM review skipped — static scan failed first';
  } else if (skipLlm || !isCustomScriptLlmReviewEnabled()) {
    llm_review = {
      enabled: false,
      certified: true,
      recommendation: 'approve',
      risk_level: 'low',
      summary: skipLlm ? 'LLM review skipped by caller' : 'LLM review disabled',
      concerns: [],
      positive_signals: [],
      skipped: true,
      reviewed_at: new Date().toISOString(),
    };
  }

  const llmFindings = llmFindingsFromReview(llm_review);
  const findings = [...static_scan.findings, ...llmFindings];

  const staticPassed = static_scan.passed;
  const llmPassed = !llm_review.enabled || llm_review.skipped || llm_review.fallback || llm_review.certified;
  const passed = staticPassed && llmPassed;

  let risk_level = static_scan.risk_level || 'low';
  if (llm_review.enabled && !llm_review.skipped && !llm_review.fallback) {
    risk_level = maxRisk(risk_level, llm_review.risk_level || 'low');
  }
  if (!passed && risk_level === 'low') risk_level = 'high';

  return {
    passed,
    risk_level,
    runtime_profile: static_scan.runtime_profile,
    language: static_scan.language,
    findings,
    static_scan,
    llm_review,
    scanned_at: new Date().toISOString(),
    byte_size: static_scan.byte_size,
  };
}

/** Sync static-only scan (legacy / quick draft preview). */
export function scanCustomScriptDraftSync({ source, language, runtimeProfile }) {
  return scanCustomScriptSource({ source, language, runtimeProfile });
}
