/**
 * Parse maker exit reviews → place body for SELL_TO_CLOSE + HOLD records.
 * Inputs: text (maker JSON)
 * Context: workflow_variables
 */
export async function run(inputs = {}, context = {}) {
  const raw = String(inputs.text || inputs.payload || '').trim();
  let plan;
  try {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fence ? fence[1].trim() : raw;
    plan = JSON.parse(body.includes('{') ? body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1) : body);
  } catch (e) {
    return { ok: false, has_sells: 'false', decision: 'rejected', text: e.message, place_body: '{}' };
  }

  const vars = context.workflow_variables || context.variables || {};
  const maxExt = Number(vars.max_hold_extension_days ?? 2);
  const reviews = Array.isArray(plan.reviews) ? plan.reviews : [];
  const sells = [];
  const holds = [];

  for (const r of reviews) {
    const decision = String(r.decision || '').toUpperCase().replace(/-/g, '_');
    const key = String(r.key || '').toUpperCase();
    if (decision === 'SELL_TO_CLOSE' || decision === 'SELL') {
      const parts = key.split(':');
      sells.push({
        key,
        symbol: parts[1] || r.symbol,
        exchange: parts[0] || r.exchange || 'SMART',
        currency: r.currency || 'USD',
        side: 'SELL_TO_CLOSE',
        qty: Number(r.qty) || 0,
        reference_price: Number(r.reference_price || r.entry_price) || 0,
        entry_price: Number(r.entry_price || r.reference_price) || 0,
        stop_pct: 0,
        tp_pct: 0,
        thesis: r.thesis || '',
        risks: r.risks || '',
        why_now: r.why_now || '',
        rationale: r.rationale || [r.thesis, r.risks, r.why_now].filter(Boolean).join(' | '),
      });
    } else if (decision === 'HOLD') {
      const extend = Math.min(maxExt, Math.max(0, Number(r.extend_days) || 1));
      holds.push({ key, extend_days: extend, review: r });
    }
  }

  const placeBody = {
    trades_to_place: sells,
    trades: sells,
    residual: [],
    source: 'poller',
    cancel_source: 'poller',
  };

  return {
    ok: true,
    has_sells: sells.length > 0 ? 'true' : 'false',
    has_holds: holds.length > 0 ? 'true' : 'false',
    sells_count: sells.length,
    holds_count: holds.length,
    holds,
    holds_body: JSON.stringify({ holds }),
    place_body: JSON.stringify(placeBody),
    text: JSON.stringify({ sells: sells.length, holds: holds.length }),
    decision: 'ok',
  };
}
