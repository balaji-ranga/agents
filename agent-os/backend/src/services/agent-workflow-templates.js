/**
 * Built-in agent workflow templates (separate from imperative job-applicant pipeline).
 */

export const JOB_APPLICANT_TEMPLATE_ID = 'template-job-applicant-pipeline';
export const JOB_APPLICANT_CHAT_PHRASE = 'run job applicant pipeline';

const PIPELINE_SCOPE = `Use the active job search profile (job_check_profile_active + job_search_profile_get).
Always pass ceo_user_id and profile_id in profile and job tool calls.
This is an automated pipeline step — work autonomously. Do NOT call job_run_workflow_now.`;

function agentNode(id, label, agentId, agentName, x, prompt, inputFromId = 'trigger-1') {
  return {
    id,
    type: 'agent',
    position: { x, y: 120 },
    data: {
      label,
      agentId,
      agentName,
      prompt,
      inputBindings: [
        {
          id: 'prompt',
          label: 'Task / prompt',
          mode: 'dynamic',
          sourceNodeId: inputFromId,
          sourceOutputKey: 'text',
          value: '',
        },
      ],
      outputs: [{ id: 'text', label: 'Agent response' }],
    },
  };
}

/** Linear job-applicant pipeline matching /job-workflows stage order (without CEO Kanban gate). */
export function buildJobApplicantPipelineGraph({
  scheduleCron = '0 * * * *',
  chatPhrase = JOB_APPLICANT_CHAT_PHRASE,
  triggerModes = ['manual', 'chat'],
} = {}) {
  const nodes = [
    {
      id: 'trigger-1',
      type: 'trigger',
      position: { x: 40, y: 120 },
      data: {
        label: 'Start',
        triggerModes,
        scheduleCron: triggerModes.includes('schedule') ? scheduleCron : '',
        chatPhrase: triggerModes.includes('chat') ? chatPhrase : '',
        inputBindings: [],
        outputs: [{ id: 'trigger_input', label: 'Trigger payload' }],
      },
    },
    {
      ...agentNode(
        'agent-discovery',
        'Job Discovery',
        'jobdiscovery',
        'Job Discovery',
        260,
        `${PIPELINE_SCOPE}

Discover new jobs for the active profile. Use job_inventory_summary, browser (profile=openclaw), and jobs_append.
Report harvest count, appended count, and sample URLs.

{{input}}`
      ),
      position: { x: 260, y: 120 },
    },
    {
      ...agentNode(
        'agent-fitscorer',
        'Fit Scoring',
        'fitscorer',
        'Fit Scoring',
        480,
        `${PIPELINE_SCOPE}

Score all jobs with status "discovered". Use job_fit_score / jobs_update. Shortlist or skip per fit_threshold.
Report counts by status.

Prior step summary:
{{input}}`,
        'agent-discovery'
      ),
      position: { x: 480, y: 120 },
    },
    {
      ...agentNode(
        'agent-resumetailor',
        'Resume Tailoring',
        'resumetailor',
        'Resume Tailoring',
        700,
        `${PIPELINE_SCOPE}

Tailor materials for jobs with status "shortlisted". Update jobs to awaiting_approval.
Note: the imperative Job workflow submits CEO Kanban review here — approve jobs on Kanban before application.

Prior step summary:
{{input}}`,
        'agent-fitscorer'
      ),
      position: { x: 700, y: 120 },
    },
    {
      ...agentNode(
        'agent-application',
        'Application Agent',
        'applicationagent',
        'Application Agent',
        920,
        `${PIPELINE_SCOPE}

Apply only to jobs with status "approved". Follow submit_policy. Update job status to applied or failed.

Prior step summary:
{{input}}`,
        'agent-resumetailor'
      ),
      position: { x: 920, y: 120 },
    },
  ];

  return {
    nodes,
    edges: [
      { id: 'e1', source: 'trigger-1', target: 'agent-discovery' },
      { id: 'e2', source: 'agent-discovery', target: 'agent-fitscorer' },
      { id: 'e3', source: 'agent-fitscorer', target: 'agent-resumetailor' },
      { id: 'e4', source: 'agent-resumetailor', target: 'agent-application' },
    ],
    viewport: { x: 0, y: 0, zoom: 0.85 },
  };
}

export function getWorkflowTemplates() {
  return [
    {
      id: JOB_APPLICANT_TEMPLATE_ID,
      name: 'Job Applicant Pipeline',
      description:
        'Mirrors Job workflows: Job Discovery → Fit Scoring → Resume Tailoring → Application Agent. Requires an active job profile. CEO Kanban approval after tailoring is handled outside this graph (same as Job workflows).',
      category: 'job',
      default_trigger_modes: ['manual', 'chat'],
      default_schedule_cron: '0 * * * *',
      default_chat_phrase: JOB_APPLICANT_CHAT_PHRASE,
      graph: buildJobApplicantPipelineGraph(),
    },
    {
      id: 'template-job-discovery-email',
      name: 'Job Discovery → Email',
      description: 'Job Discovery agent produces an email body → Send Email task (static To + dynamic body).',
      category: 'job',
      default_trigger_modes: ['manual', 'chat'],
      default_schedule_cron: '',
      default_chat_phrase: 'run job discovery email workflow',
      graph: null,
      seed_script: 'seed-sample-job-discovery-email-workflow.js',
    },
  ];
}

export function getWorkflowTemplate(templateId) {
  const templates = getWorkflowTemplates();
  const found = templates.find((t) => t.id === templateId);
  if (!found) return null;
  if (found.id === JOB_APPLICANT_TEMPLATE_ID) {
    return {
      ...found,
      graph: buildJobApplicantPipelineGraph({
        scheduleCron: found.default_schedule_cron,
        chatPhrase: found.default_chat_phrase,
        triggerModes: found.default_trigger_modes,
      }),
    };
  }
  return found;
}
