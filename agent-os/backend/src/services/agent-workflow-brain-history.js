/**
 * Query Brain node I/O from workflow run-step audit; optional LLM summary for Maker context.
 */
import { getDb } from '../db/schema.js';
import { chatCompletions } from '../config/llm.js';

const MAX_ENTRIES = 80;
const MAX_IO_CHARS = 2500;
const MAX_SUMMARY_ENTRIES = 40;

function asArray(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return [];
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
      } catch {
        /* fall through */
      }
    }
    return t.split(/[,|\s]+/).map((x) => x.trim()).filter(Boolean);
  }
  return [String(v).trim()].filter(Boolean);
}

function safeJson(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function truncate(s, n = MAX_IO_CHARS) {
  const t = String(s ?? '');
  if (t.length <= n) return t;
  return `${t.slice(0, n)}…`;
}

function extractBrainIo(inputJson, outputJson) {
  const input = safeJson(inputJson) || {};
  const output = safeJson(outputJson) || {};
  const resolved = input.resolved || {};
  const userMessage =
    resolved.userMessage ||
    resolved.prompt ||
    resolved.body ||
    input.userMessage ||
    null;
  const text =
    output.text != null
      ? String(output.text)
      : output.outputs?.find?.((o) => o.id === 'text')?.value != null
        ? String(output.outputs.find((o) => o.id === 'text').value)
        : null;

  return {
    input_preview: truncate(
      userMessage != null
        ? typeof userMessage === 'object'
          ? JSON.stringify(userMessage)
          : String(userMessage)
        : JSON.stringify(resolved || input).slice(0, MAX_IO_CHARS)
    ),
    output_text: truncate(text || JSON.stringify(output).slice(0, MAX_IO_CHARS)),
    model_used: output.model_used || output.provider || null,
    user_message_preview: truncate(output.user_message_preview || '', 1200),
  };
}

/**
 * @param {{
 *   ownerUserId: string,
 *   workflowIds?: string[],
 *   nodeIds?: string[],
 *   days?: number,
 *   limit?: number,
 * }} opts
 */
export function queryBrainHistoryEntries({
  ownerUserId,
  workflowIds = [],
  nodeIds = [],
  days = 7,
  limit = 40,
} = {}) {
  const db = getDb();
  const wfIds = asArray(workflowIds);
  const nIds = asArray(nodeIds);
  const dayWindow = Math.min(Math.max(Number(days) || 7, 1), 90);
  const lim = Math.min(Math.max(Number(limit) || 40, 1), MAX_ENTRIES);

  if (!ownerUserId) throw new Error('owner_user_id required');
  if (!wfIds.length) throw new Error('workflow_id required (string or array)');
  if (!nIds.length) throw new Error('node_id required (string or array)');

  const wfPlace = wfIds.map(() => '?').join(',');
  const nodePlace = nIds.map(() => '?').join(',');

  const rows = db
    .prepare(
      `SELECT
         s.id AS step_id,
         s.run_id,
         s.node_id,
         s.node_type,
         s.node_label,
         s.status,
         s.iteration,
         s.input_json,
         s.output_json,
         s.error_message,
         s.started_at,
         s.completed_at,
         r.definition_id AS workflow_id,
         r.run_number,
         r.status AS run_status,
         r.started_at AS run_started_at
       FROM agent_workflow_run_steps s
       JOIN agent_workflow_runs r ON r.id = s.run_id
       WHERE r.owner_user_id = ?
         AND s.node_type = 'brain'
         AND s.status = 'completed'
         AND r.definition_id IN (${wfPlace})
         AND s.node_id IN (${nodePlace})
         AND COALESCE(s.completed_at, s.started_at, r.started_at) >= datetime('now', ?)
       ORDER BY COALESCE(s.completed_at, s.started_at, r.started_at) DESC, s.id DESC
       LIMIT ?`
    )
    .all(ownerUserId, ...wfIds, ...nIds, `-${dayWindow} days`, lim);

  return rows.map((row) => {
    const io = extractBrainIo(row.input_json, row.output_json);
    return {
      step_id: row.step_id,
      run_id: row.run_id,
      run_number: row.run_number,
      workflow_id: row.workflow_id,
      node_id: row.node_id,
      node_label: row.node_label,
      iteration: row.iteration ?? 1,
      status: row.status,
      started_at: row.started_at,
      completed_at: row.completed_at,
      run_started_at: row.run_started_at,
      run_status: row.run_status,
      ...io,
    };
  });
}

function buildActualContextText(entries) {
  if (!entries.length) return 'No prior Brain history in the requested window.';
  const parts = entries.map((e, i) => {
    return [
      `### ${i + 1}. ${e.workflow_id} / ${e.node_id} (run #${e.run_number}, iter ${e.iteration}, ${e.completed_at || e.started_at})`,
      `INPUT: ${e.input_preview}`,
      `OUTPUT: ${e.output_text}`,
    ].join('\n');
  });
  return parts.join('\n\n');
}

async function summarizeEntries(entries, { purpose = 'trading_maker' } = {}) {
  const slice = entries.slice(0, MAX_SUMMARY_ENTRIES);
  const raw = buildActualContextText(slice);
  const system = `You compress Brain workflow audit history into durable lessons for a downstream agent.
Return plain text only (no markdown fences, no JSON). Prefer short bullets.
Focus on: repeated mistakes, checker reject themes, symbols/products to avoid, sizing/budget lessons, what got approved and why.
Omit ephemeral noise (timestamps, raw dumps) unless essential.
Max ~600 words.`;

  const user = `Purpose: ${purpose}
History window entries (${slice.length}):

${raw.slice(0, 28000)}

Write the learning context now.`;

  const { content, modelUsed } = await chatCompletions({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    maxTokens: 1200,
  });
  return {
    summary: String(content || '').trim() || 'No summary produced.',
    model_used: modelUsed,
  };
}

/**
 * @param {{
 *   ownerUserId: string,
 *   workflowIds: string[]|string,
 *   nodeIds: string[]|string,
 *   days?: number,
 *   limit?: number,
 *   responseType?: 'actual'|'summarized',
 *   purpose?: string,
 * }} opts
 */
export async function getBrainHistory(opts = {}) {
  const responseType = String(opts.responseType || opts.response_type || 'actual').toLowerCase();
  const days = Number(opts.days) || 7;
  const workflowIds = asArray(opts.workflowIds ?? opts.workflow_id ?? opts.workflow_ids);
  const nodeIds = asArray(opts.nodeIds ?? opts.node_id ?? opts.node_ids);

  const entries = queryBrainHistoryEntries({
    ownerUserId: opts.ownerUserId || opts.owner_user_id,
    workflowIds,
    nodeIds,
    days,
    limit: opts.limit,
  });

  const base = {
    ok: true,
    response_type: responseType === 'summarized' ? 'summarized' : 'actual',
    days,
    workflow_ids: workflowIds,
    node_ids: nodeIds,
    entry_count: entries.length,
  };

  if (responseType === 'summarized') {
    if (!entries.length) {
      const empty =
        'No prior Brain maker/checker history in this window. Proceed from snapshot + current constraints only.';
      return {
        ...base,
        entries: [],
        summary: empty,
        context_text: empty,
        bodyText: empty,
        model_used: null,
      };
    }
    const { summary, model_used } = await summarizeEntries(entries, {
      purpose: opts.purpose || 'IBKR maker day-plan / poller learning context',
    });
    return {
      ...base,
      // Keep compact entry index; full I/O is summarized
      entries: entries.map((e) => ({
        step_id: e.step_id,
        run_id: e.run_id,
        workflow_id: e.workflow_id,
        node_id: e.node_id,
        iteration: e.iteration,
        completed_at: e.completed_at,
      })),
      summary,
      context_text: summary,
      bodyText: summary,
      model_used,
    };
  }

  const context_text = buildActualContextText(entries);
  return {
    ...base,
    entries,
    summary: null,
    context_text,
    bodyText: context_text,
    model_used: null,
  };
}
