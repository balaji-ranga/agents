/** Classify workflow agent chat responses into UI refresh/navigation effects. */

const GRAPH_ACTIONS = new Set([
  'add_node',
  'update_node',
  'delete_node',
  'add_edge',
  'delete_edge',
  'connect',
  'connect_nodes',
]);

const LIFECYCLE_ACTIONS = new Set([
  'create_workflow',
  'open_workflow',
  'load_workflow',
  'reload_workflow',
  'publish',
  'unpublish',
  'revert_to_draft',
  'unpublish_workflow',
  'pause_workflow',
  'resume_workflow',
  'set_metadata',
  'set_status',
  'delete_workflow',
]);

const RUN_ACTIONS = new Set([
  'trigger_workflow',
  'trigger_run',
  'test_workflow',
  'inspect_run',
  'pause_run',
  'stop_run',
  'cancel_run',
  'delete_run',
  'pause_all_runs',
  'stop_listen',
]);

function actionNames(res) {
  return (res?.actions_applied || []).map((a) => a.action).filter(Boolean);
}

function findAction(res, names) {
  const set = new Set(names);
  return (res?.actions_applied || []).find((a) => set.has(a.action));
}

function toastForAction(action) {
  if (!action || action.ok === false) return null;
  const map = {
    create_workflow: 'Workflow created',
    publish: 'Workflow published',
    unpublish: 'Workflow reverted to draft',
    revert_to_draft: 'Workflow reverted to draft',
    unpublish_workflow: 'Workflow reverted to draft',
    pause_workflow: 'Workflow paused',
    resume_workflow: 'Workflow resumed',
    delete_workflow: 'Workflow deleted',
    reload_workflow: 'Workflow reloaded',
    open_workflow: 'Workflow opened',
    load_workflow: 'Workflow opened',
    trigger_workflow: 'Run started',
    test_workflow: 'Test run started',
    pause_run: 'Run paused',
    stop_run: 'Run stopped',
    cancel_run: 'Run stopped',
    delete_run: 'Run deleted',
    pause_all_runs: 'Runs paused',
  };
  return map[action.action] || null;
}

/**
 * @param {object} res Agent chat API response
 * @param {{ currentWorkflowId?: string|null, onEditor?: boolean }} ctx
 */
export function deriveWorkflowAgentUiEffects(res, ctx = {}) {
  const actions = res?.actions_applied || [];
  const names = actionNames(res);
  const workflowId = res?.workflow_id || ctx.currentWorkflowId || null;
  const onEditor = !!ctx.onEditor;

  const graphChanged = names.some((n) => GRAPH_ACTIONS.has(n));
  const lifecycleChanged = names.some((n) => LIFECYCLE_ACTIONS.has(n));
  const runChanged = names.some((n) => RUN_ACTIONS.has(n));

  const deleted = names.includes('delete_workflow');
  const created = findAction(res, ['create_workflow']);
  const opened = findAction(res, ['open_workflow', 'load_workflow', 'reload_workflow']);
  const published = findAction(res, ['publish']);
  const publishOk = published && published.ok !== false;
  const unpublished = findAction(res, ['unpublish', 'revert_to_draft', 'unpublish_workflow']);
  const triggered =
    res?.workflow_triggered ||
    findAction(res, ['trigger_workflow', 'trigger_run', 'test_workflow']);
  const inspected = findAction(res, ['inspect_run']);

  const needsGraphRefresh =
    graphChanged || !!res?.draft_graph || names.includes('create_workflow') || !!opened;

  const shouldReloadWorkflow =
    !!opened || (!!published && publishOk) || !!unpublished || names.includes('set_metadata') || deleted;

  const shouldRefreshAudit =
    lifecycleChanged && !deleted && !!workflowId;

  let navigate = null;
  if (deleted && onEditor) {
    navigate = { type: 'list' };
  } else if (created?.workflow_id && created.workflow_id !== ctx.currentWorkflowId) {
    navigate = { type: 'editor', workflowId: created.workflow_id };
  } else if (opened?.workflow_id && !onEditor) {
    navigate = { type: 'editor', workflowId: opened.workflow_id };
  } else if (workflowId && created?.workflow_id === workflowId && !onEditor) {
    navigate = { type: 'editor', workflowId };
  } else if (triggered?.run_id && !onEditor) {
    navigate = { type: 'run', runId: triggered.run_id };
  } else if (inspected?.run?.run_id && !onEditor) {
    navigate = { type: 'run', runId: inspected.run.run_id };
  }

  const primary = actions[actions.length - 1];
  const toast = toastForAction(primary) || (triggered?.run_number ? `Run #${triggered.run_number} started` : null);

  return {
    actions,
    workflowId,
    workflowDeleted: deleted,
    graphChanged,
    lifecycleChanged,
    runChanged,
    needsGraphRefresh,
    shouldReloadWorkflow,
    shouldRefreshAudit,
    shouldRefreshList: lifecycleChanged || runChanged,
    shouldRefreshRuns: runChanged,
    runStarted: triggered?.run_id
      ? {
          runId: triggered.run_id,
          runNumber: triggered.run_number,
          definitionId: triggered.definition_id || workflowId,
        }
      : null,
    runInspected: inspected?.run?.run_id
      ? { runId: inspected.run.run_id, runNumber: inspected.run.run_number }
      : null,
    navigate,
    toast,
  };
}
