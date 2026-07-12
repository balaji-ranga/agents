/**
 * Custom agent workflows API — separate from job-applicant workflows.
 */
import { Router } from 'express';
import { requireCeoOrAdmin, resolveAuthenticatedCeoUserId } from '../middleware/auth.js';
import * as store from '../services/agent-workflow-store.js';
import { syncWorkflowScheduleRegistry } from '../services/agent-workflow-store.js';
import { startAgentWorkflowRun, completeCeoApprovalResponse, stopSseListen } from '../services/agent-workflow-runner.js';
import { refreshAgentWorkflowSchedules, stopScheduleForDefinition, getScheduleRegistrySnapshot } from '../services/agent-workflow-scheduler.js';
import { getTaskCatalog } from '../services/agent-workflow-task-catalog.js';
import { getWorkflowTemplates, getWorkflowTemplate } from '../services/agent-workflow-templates.js';
import {
  pauseRun,
  deleteRun,
  pauseAllRuns,
  deleteAllRuns,
  deleteDefinitionWithCleanup,
} from '../services/agent-workflow-run-manager.js';
import { getHookInfo } from '../services/agent-workflow-webhooks.js';
import { runWorkflowBuilderChat, getWorkflowBuilderChatHistory } from '../services/agent-workflow-agent.js';
import { applyWorkflowBuilderActions, getWorkflowDraftForAgent } from '../services/agent-workflow-builder.js';
import { getBrainHistory } from '../services/agent-workflow-brain-history.js';

const router = Router();

function actorFromRequest(req) {
  return {
    id: req.authUser?.id,
    name: req.authUser?.name,
    type: req.authUser?.role || 'user',
  };
}

/** Workflow API nodes may call with x-internal-test; otherwise CEO/admin auth. */
function allowInternalOrCeo(req, res, next) {
  if (req.headers['x-internal-test'] === '1') {
    req.authUser = req.authUser || {
      id: req.body?.owner_user_id || process.env.AGENT_OS_BALA_CEO_ID || 'ceo-bala',
      role: 'ceo',
    };
    return next();
  }
  return requireCeoOrAdmin(req, res, next);
}

/**
 * POST/GET /api/agent-workflows/brain-history
 * Query Brain node I/O from run-step audit.
 * Body/query: workflow_id[], node_id[], days, response_type=actual|summarized, limit
 */
async function brainHistoryHandler(req, res) {
  try {
    const src = req.method === 'GET' ? req.query : req.body || {};
    let ownerUserId = src.owner_user_id || req.authUser?.id || null;
    if (!ownerUserId) {
      try {
        ownerUserId = resolveAuthenticatedCeoUserId(req, src);
      } catch {
        ownerUserId = process.env.AGENT_OS_BALA_CEO_ID || 'ceo-bala';
      }
    }
    const result = await getBrainHistory({
      ownerUserId,
      workflowIds: src.workflow_id ?? src.workflow_ids ?? src.workflowId,
      nodeIds: src.node_id ?? src.node_ids ?? src.nodeId,
      days: src.days != null ? Number(src.days) : 7,
      limit: src.limit != null ? Number(src.limit) : 40,
      responseType: src.response_type || src.responseType || 'actual',
      purpose: src.purpose || undefined,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}

router.post('/brain-history', allowInternalOrCeo, brainHistoryHandler);
router.get('/brain-history', allowInternalOrCeo, brainHistoryHandler);

router.use(requireCeoOrAdmin);

router.get('/meta/task-types', (req, res) => {
  res.json({ task_types: getTaskCatalog() });
});

router.get('/meta/schedules', (req, res) => {
  try {
    res.json({ schedules: getScheduleRegistrySnapshot(), pid: process.pid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/meta/templates', (req, res) => {
  res.json({
    templates: getWorkflowTemplates().map(({ graph, ...meta }) => meta),
  });
});

router.get('/meta/templates/:templateId', (req, res) => {
  const template = getWorkflowTemplate(req.params.templateId);
  if (!template) return res.status(404).json({ error: 'Template not found' });
  res.json({ template });
});

router.get('/', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req);
    const search = String(req.query.q || req.query.search || '').trim();
    res.json({ workflows: store.listDefinitions(ownerUserId, { search }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/runs', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const search = String(req.query.q || req.query.search || '').trim();
    res.json(store.listAllRunsPaginated(ownerUserId, { page, limit, search }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Workflow Builder agent chat — creates/edits graph via LLM actions; returns draft_graph for live UI sync. */
router.get('/agent-chat/history', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req);
    const workflowId = req.query.workflow_id || null;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
    const turns = getWorkflowBuilderChatHistory(ownerUserId, workflowId || null, limit);
    res.json({ turns, workflow_id: workflowId || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/agent-chat', async (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req, req.body);
    const { message, workflow_id: workflowId, history } = req.body || {};
    if (!message?.trim()) return res.status(400).json({ error: 'message required' });
    const result = await runWorkflowBuilderChat({
      ownerUserId,
      workflowId: workflowId || null,
      message: String(message).trim(),
      history: Array.isArray(history) ? history : [],
      actor: actorFromRequest(req),
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Apply builder actions directly (tools / automation). */
router.post('/mutate', async (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req, req.body);
    const { workflow_id: workflowId, actions } = req.body || {};
    if (!Array.isArray(actions) || !actions.length) {
      return res.status(400).json({ error: 'actions array required' });
    }
    const result = await applyWorkflowBuilderActions(
      ownerUserId,
      workflowId || null,
      actions,
      actorFromRequest(req)
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/draft/:id', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req);
    const draft = getWorkflowDraftForAgent(ownerUserId, req.params.id);
    res.json(draft);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

router.post('/', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req, req.body);
    const {
      name,
      description,
      graph,
      template_id: templateId,
      variables,
      trigger_modes,
      schedule_cron,
      chat_trigger_phrase,
    } = req.body || {};
    let workflowName = name?.trim();
    let workflowGraph = graph;
    let triggerPatch = {};
    let workflowVariables = variables;

    if (templateId) {
      const template = getWorkflowTemplate(templateId);
      if (!template?.graph) return res.status(400).json({ error: 'Unknown or unsupported template' });
      workflowName = workflowName || template.name;
      workflowGraph = template.graph;
      triggerPatch = {
        trigger_modes: template.default_trigger_modes,
        schedule_cron: template.default_schedule_cron || '',
        chat_trigger_phrase: template.default_chat_phrase || '',
      };
    } else {
      if (trigger_modes != null) triggerPatch.trigger_modes = trigger_modes;
      if (schedule_cron != null) triggerPatch.schedule_cron = schedule_cron;
      if (chat_trigger_phrase != null) triggerPatch.chat_trigger_phrase = chat_trigger_phrase;
    }

    if (!workflowName) return res.status(400).json({ error: 'name required' });
    const def = store.createDefinition({
      name: workflowName,
      description: description ?? (templateId ? getWorkflowTemplate(templateId)?.description : ''),
      ownerUserId,
      actor: actorFromRequest(req),
      graph: workflowGraph,
      variables: workflowVariables,
      ...triggerPatch,
    });
    res.status(201).json(def);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/approval/respond', async (req, res) => {
  try {
    const { kanban_task_id: kanbanTaskId, decision, comment } = req.body || {};
    if (!kanbanTaskId) return res.status(400).json({ error: 'kanban_task_id required' });
    if (!decision || !['approve', 'reject', 'approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be approve or reject' });
    }
    const result = await completeCeoApprovalResponse({
      kanbanTaskId: Number(kanbanTaskId),
      decision,
      comment: comment || '',
      actor: actorFromRequest(req),
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/runs/pause-all', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req, req.body);
    const definitionId = req.body?.definition_id || null;
    const result = pauseAllRuns(ownerUserId, { definitionId, actor: actorFromRequest(req) });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/runs/all', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req, req.query);
    const definitionId = req.query.definition_id || null;
    const result = deleteAllRuns(ownerUserId, { definitionId, actor: actorFromRequest(req) });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/runs/:runId/listen/:nodeId/stop', async (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req, req.body);
    const result = await stopSseListen(Number(req.params.runId), req.params.nodeId, ownerUserId, {
      actor: actorFromRequest(req),
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/runs/:runId/pause', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req, req.body);
    const run = pauseRun(Number(req.params.runId), ownerUserId, actorFromRequest(req));
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/runs/:runId', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req);
    const result = deleteRun(Number(req.params.runId), ownerUserId, actorFromRequest(req));
    if (!result) return res.status(404).json({ error: 'Run not found' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/runs/:runId', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req);
    const run = store.getRun(Number(req.params.runId), ownerUserId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/hook', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req);
    const info = getHookInfo(req.params.id, ownerUserId);
    if (!info) return res.status(404).json({ error: 'Workflow not found' });
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req);
    const def = store.getDefinition(req.params.id, ownerUserId);
    if (!def) return res.status(404).json({ error: 'Workflow not found' });
    res.json(def);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req, req.body);
    const def = store.updateDraft(req.params.id, ownerUserId, req.body || {}, actorFromRequest(req));
    if (!def) return res.status(404).json({ error: 'Workflow not found' });
    if (def.status === 'published') refreshAgentWorkflowSchedules();
    res.json(def);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/pause', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req, req.body);
    const actor = actorFromRequest(req);
    const def = store.setPaused(req.params.id, ownerUserId, true, actor);
    if (!def) return res.status(404).json({ error: 'Workflow not found' });
    stopScheduleForDefinition(req.params.id);
    pauseAllRuns(ownerUserId, { definitionId: req.params.id, actor });
    refreshAgentWorkflowSchedules();
    res.json(def);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/resume', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req, req.body);
    const def = store.setPaused(req.params.id, ownerUserId, false, actorFromRequest(req));
    if (!def) return res.status(404).json({ error: 'Workflow not found' });
    refreshAgentWorkflowSchedules();
    res.json(def);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id/triggers', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req, req.body);
    const def = store.updateTriggers(req.params.id, ownerUserId, req.body || {}, actorFromRequest(req));
    if (!def) return res.status(404).json({ error: 'Workflow not found' });
    stopScheduleForDefinition(req.params.id);
    refreshAgentWorkflowSchedules();
    res.json(def);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/publish', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req, req.body);
    const def = store.publishDefinition(req.params.id, ownerUserId, actorFromRequest(req));
    if (!def) return res.status(404).json({ error: 'Workflow not found' });
    refreshAgentWorkflowSchedules();
    res.json(def);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/unpublish', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req, req.body);
    const actor = actorFromRequest(req);
    const def = store.unpublishDefinition(req.params.id, ownerUserId, actor);
    if (!def) return res.status(404).json({ error: 'Workflow not found' });
    stopScheduleForDefinition(req.params.id);
    refreshAgentWorkflowSchedules();
    res.json(def);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:id/audit', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    res.json({ audit: store.listAudit(req.params.id, ownerUserId, limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/runs', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req);
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    res.json({ runs: store.listRuns(req.params.id, ownerUserId, limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/run', async (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req, req.body);
    const input = req.body?.input ?? req.body?.message ?? '';
    const run = await startAgentWorkflowRun(req.params.id, ownerUserId, {
      trigger: 'manual',
      input: String(input),
      actor: actorFromRequest(req),
    });
    res.status(201).json(run);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req);
    const ok = deleteDefinitionWithCleanup(req.params.id, ownerUserId, actorFromRequest(req));
    if (!ok) return res.status(404).json({ error: 'Workflow not found' });
    refreshAgentWorkflowSchedules();
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
