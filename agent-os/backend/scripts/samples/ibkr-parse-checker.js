/**
 * Parse checker Brain JSON → decision / adjustments for while + if nodes.
 * Must export: run(inputs, context)
 */
export function run(inputs = {}, context = {}) {
  const text =
    inputs.text ||
    inputs.payload ||
    inputs.checker_text ||
    context?.node_outputs?.['checker-1']?.text ||
    context?.node_outputs?.['checker-exit']?.text ||
    '';
  const raw = String(text || '').trim();
  let parsed = null;
  try {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fence ? fence[1].trim() : raw;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    parsed = JSON.parse(start >= 0 ? body.slice(start, end + 1) : body);
  } catch {
    parsed = null;
  }

  let decision = String(parsed?.decision || parsed?.verdict || '').toLowerCase();
  if (decision !== 'approved' && decision !== 'rejected') {
    const lower = raw.toLowerCase();
    if (lower.includes('"decision":"approved"') || (/\bapproved\b/.test(lower) && !/\brejected\b/.test(lower))) {
      decision = 'approved';
    } else {
      decision = 'rejected';
    }
  }

  let adjustments = parsed?.adjustments ?? parsed?.recommendations ?? '';
  if (Array.isArray(adjustments)) adjustments = adjustments.filter(Boolean).join('\n- ');
  else if (adjustments && typeof adjustments === 'object') adjustments = JSON.stringify(adjustments);
  else adjustments = String(adjustments || '').trim();

  // Unwrap accidental nested JSON in adjustments
  if (adjustments.startsWith('{')) {
    try {
      const nested = JSON.parse(adjustments);
      if (nested && typeof nested === 'object') {
        if (nested.adjustments != null) {
          adjustments = Array.isArray(nested.adjustments)
            ? nested.adjustments.filter(Boolean).join('\n- ')
            : String(nested.adjustments);
        }
        if (!decision || decision === 'rejected') {
          const d = String(nested.decision || '').toLowerCase();
          if (d === 'approved' || d === 'rejected') decision = d;
        }
      }
    } catch {
      /* keep */
    }
  }

  if (!adjustments && parsed?.notes) adjustments = String(parsed.notes);
  // On reject with empty adjustments, fall back to raw checker text so maker still gets something actionable
  if (decision === 'rejected' && !adjustments) {
    adjustments = raw.slice(0, 1500);
  }

  const plan = parsed?.plan || parsed?.trade_plan || null;
  const makerText =
    context?.node_outputs?.['maker-1']?.text ||
    context?.node_outputs?.['maker-exit']?.text ||
    '';

  return {
    ok: true,
    decision,
    adjustments,
    plan_json: plan ? JSON.stringify(plan) : '',
    maker_text: String(makerText),
    text: JSON.stringify({ decision, adjustments: adjustments.slice(0, 800) }),
  };
}
