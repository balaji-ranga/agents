/**
 * LLM security review for custom scripts — second opinion after static regex scan.
 * Uses platform LLM config (backend .env / Ollama). No workflow node keys.
 */
import { chatCompletions } from '../config/llm.js';

const REVIEW_SYSTEM = `You are a security reviewer for user-submitted workflow scripts (Python or JavaScript).
These scripts run in a sandboxed subprocess inside an agent workflow platform.

Your job: certify whether the script is safe to approve, or reject it.

Flag and REJECT scripts that:
- Execute shell commands, subprocess, or OS-level access
- Read/write/delete files outside sandbox intent (e.g. /etc/passwd, ~/.ssh, env files)
- Exfiltrate secrets, credentials, or environment variables
- Make network calls to exfiltrate data (unless clearly benign and documented)
- Use eval, exec, compile, dynamic import, obfuscation, or hidden backdoors
- Attempt privilege escalation, crypto mining, or resource exhaustion attacks
- Contain deceptive code (benign entrypoint hiding malicious logic)

APPROVE scripts that:
- Transform workflow inputs to outputs (text, JSON, counts, formatting)
- Use only safe stdlib logic appropriate for sandboxed data processing
- Have a clear, honest run_graph(inputs) or run(inputs) entrypoint

Respond with a single JSON object only (no markdown fences):
{
  "certified": true or false,
  "recommendation": "approve" or "reject",
  "risk_level": "low" | "medium" | "high" | "critical",
  "summary": "brief explanation",
  "concerns": ["specific issue 1", "..."],
  "positive_signals": ["why safe if approving"]
}`;

export function isCustomScriptLlmReviewEnabled() {
  return String(process.env.CUSTOM_SCRIPT_LLM_REVIEW ?? '1').trim() !== '0';
}

export function isCustomScriptLlmReviewRequired() {
  return String(process.env.CUSTOM_SCRIPT_LLM_REVIEW_REQUIRED ?? '1').trim() !== '0';
}

function parseReviewJson(content) {
  const text = String(content || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const block = text.match(/\{[\s\S]*\}/);
    if (!block) return null;
    try {
      return JSON.parse(block[0]);
    } catch {
      return null;
    }
  }
}

function normalizeReview(parsed, { modelUsed, error = null } = {}) {
  if (error) {
    return {
      enabled: true,
      certified: false,
      recommendation: 'reject',
      risk_level: 'high',
      summary: error,
      concerns: [error],
      positive_signals: [],
      model_used: modelUsed || null,
      reviewed_at: new Date().toISOString(),
      parse_error: true,
    };
  }

  const recommendation = String(parsed?.recommendation || '').toLowerCase();
  const certified = parsed?.certified === true && recommendation === 'approve';
  const concerns = Array.isArray(parsed?.concerns)
    ? parsed.concerns.map((c) => String(c).trim()).filter(Boolean)
    : [];
  const positive = Array.isArray(parsed?.positive_signals)
    ? parsed.positive_signals.map((c) => String(c).trim()).filter(Boolean)
    : [];

  let risk = String(parsed?.risk_level || 'medium').toLowerCase();
  if (!['low', 'medium', 'high', 'critical'].includes(risk)) risk = 'medium';

  if (!certified && concerns.length === 0) {
    concerns.push(parsed?.summary || 'LLM reviewer rejected script');
  }

  return {
    enabled: true,
    certified,
    recommendation: certified ? 'approve' : 'reject',
    risk_level: certified ? risk : risk === 'low' ? 'high' : risk,
    summary: String(parsed?.summary || (certified ? 'LLM certified script as safe' : 'LLM rejected script')).trim(),
    concerns,
    positive_signals: positive,
    model_used: modelUsed || null,
    reviewed_at: new Date().toISOString(),
  };
}

/**
 * @returns {Promise<object>} llm_review block for scan_result
 */
export async function reviewCustomScriptWithLlm({
  source,
  language = 'python',
  runtimeProfile = 'restricted',
  staticFindings = [],
  scriptName = '',
} = {}) {
  if (!isCustomScriptLlmReviewEnabled()) {
    return {
      enabled: false,
      certified: true,
      recommendation: 'approve',
      risk_level: 'low',
      summary: 'LLM review disabled (CUSTOM_SCRIPT_LLM_REVIEW=0)',
      concerns: [],
      positive_signals: [],
      skipped: true,
      reviewed_at: new Date().toISOString(),
    };
  }

  const staticSummary =
    staticFindings.length > 0
      ? `\nStatic scanner findings:\n${staticFindings.map((f) => `- [${f.severity}] ${f.rule}: ${f.message}`).join('\n')}`
      : '\nStatic scanner: no critical/high findings.';

  const userContent = `Review this ${language} custom workflow script (runtime profile: ${runtimeProfile}).
Script name: ${scriptName || '(unnamed)'}
${staticSummary}

\`\`\`${language}
${String(source || '').slice(0, 12000)}
\`\`\``;

  try {
    const maxTokens = Number(process.env.CUSTOM_SCRIPT_LLM_REVIEW_MAX_TOKENS) || 768;
    const { content, modelUsed } = await chatCompletions({
      messages: [
        { role: 'system', content: REVIEW_SYSTEM },
        { role: 'user', content: userContent },
      ],
      maxTokens,
    });

    const parsed = parseReviewJson(content);
    if (!parsed) {
      const msg = 'LLM review returned unparseable response';
      if (isCustomScriptLlmReviewRequired()) {
        return normalizeReview(null, { modelUsed, error: msg });
      }
      return {
        enabled: true,
        certified: true,
        recommendation: 'approve',
        risk_level: 'medium',
        summary: `${msg} — falling back to static scan only`,
        concerns: [],
        positive_signals: [],
        model_used: modelUsed,
        reviewed_at: new Date().toISOString(),
        parse_error: true,
        fallback: true,
      };
    }

    return normalizeReview(parsed, { modelUsed });
  } catch (err) {
    const msg = `LLM review unavailable: ${err.message}`;
    if (isCustomScriptLlmReviewRequired()) {
      return normalizeReview(null, { error: msg });
    }
    return {
      enabled: true,
      certified: true,
      recommendation: 'approve',
      risk_level: 'medium',
      summary: `${msg} — falling back to static scan only`,
      concerns: [],
      positive_signals: [],
      skipped: true,
      skip_reason: err.message,
      reviewed_at: new Date().toISOString(),
      fallback: true,
    };
  }
}

export function llmFindingsFromReview(llmReview) {
  if (!llmReview?.enabled || llmReview.skipped || llmReview.fallback) return [];
  if (llmReview.certified) return [];
  return (llmReview.concerns || []).map((message) => ({
    rule: 'llm_review',
    severity: llmReview.risk_level === 'critical' ? 'critical' : llmReview.risk_level === 'high' ? 'high' : 'medium',
    line: 1,
    message: `LLM review: ${message}`,
  }));
}
