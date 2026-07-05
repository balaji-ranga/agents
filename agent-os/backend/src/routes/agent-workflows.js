/**
 * Custom agent workflows API — separate from job-applicant workflows.
 */
import { Router } from 'express';
import { requireCeoOrAdmin, resolveAuthenticatedCeoUserId } from '../middleware/auth.js';
import * as store from '../services/agent-workflow-store.js';
import { syncWorkflowScheduleRegistry } from '../services/agent-workflow-store.js';
import { startAgentWorkflowRun, completeCeoApprovalResponse } from '../services/agent-workflow-runner.js';
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
import { runWorkflowBuilderChat } from '../services/agent-workflow-agent.js';
import { applyWorkflowBuilderActions, getWorkflowDraftForAgent } from '../services/agent-workflow-builder.js';

const router = Router();

function actorFromRequest(req) {
  return {
    id: req.authUser?.id,
    name: req.authUser?.name,
    type: req.authUser?.role || 'user',
  };
}

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
    res.json({ workflows: store.listDefinitions(ownerUserId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/runs', (req, res) => {
  try {
    const ownerUserId = resolveAuthenticatedCeoUserId(req);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    res.json({ runs: store.listAllRuns(ownerUserId, limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Workflow Builder agent chat — creates/edits graph via LLM actions; returns draft_graph for live UI sync. */
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
    const { name, description, graph, template_id: templateId } = req.body || {};
    let workflowName = name?.trim();
    let workflowGraph = graph;
    let triggerPatch = {};

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
    }

    if (!workflowName) return res.status(400).json({ error: 'name required' });
    const def = store.createDefinition({
      name: workflowName,
      description: description ?? (templateId ? getWorkflowTemplate(templateId)?.description : ''),
      ownerUserId,
      actor: actorFromRequest(req),
      graph: workflowGraph,
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
