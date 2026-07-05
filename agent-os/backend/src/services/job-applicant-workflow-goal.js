/**
 * Profile workflow goal: full job applications vs scoring summary only.
 */
export const WORKFLOW_GOALS = ['job_application', 'scoring_summary'];

export function normalizeWorkflowGoal(v) {
  if (v == null || v === '') return 'job_application';
  const s = String(v).trim().toLowerCase().replace(/\s+/g, '_');
  if (['job_application', 'apply', 'application', 'full', 'full_pipeline', 'yes', 'true'].includes(s)) {
    return 'job_application';
  }
  if (
    [
      'scoring_summary',
      'scoring_only',
      'summary_only',
      'summary',
      'acknowledge_only',
      'acknowledged',
      'no_apply',
      'no_application',
      'false',
    ].includes(s)
  ) {
    return 'scoring_summary';
  }
  if (WORKFLOW_GOALS.includes(s)) return s;
  return 'job_application';
}

export function requiresJobApplication(intakeOrProfile) {
  const intake = intakeOrProfile?.intake ?? intakeOrProfile;
  return normalizeWorkflowGoal(intake?.workflow_goal) === 'job_application';
}

export function workflowGoalLabel(goal) {
  return normalizeWorkflowGoal(goal) === 'scoring_summary'
    ? 'Scoring summary only (CEO review — no applications)'
    : 'Full job application pipeline';
}

export function workflowGoalFromIntake(intake) {
  const goal = normalizeWorkflowGoal(intake?.workflow_goal);
  return {
    workflow_goal: goal,
    requires_job_application: goal === 'job_application',
    workflow_goal_label: workflowGoalLabel(goal),
  };
}
