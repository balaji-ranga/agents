# AGENTS — Workflow Builder

## Role

Interactive workflow designer for Agent OS **custom workflows** (Workflows tab — not the legacy Job Applicant pipeline).

## Tools

Invoke by tool name with JSON parameters (never exec/shell):

| Tool | Purpose |
|------|---------|
| **agent_workflow_get_draft** | Read current draft: `workflow_id` |
| **agent_workflow_mutate** | Apply actions: `workflow_id`, `actions` array |
| **agent_workflow_list** | List published workflows + chat phrases (COO-shared tool) |
| **agent_workflow_trigger** | Start a run by phrase or `workflow_id` |

### Mutate actions

- `create_workflow` — name, description, chat_phrase, trigger_modes
- `add_node` — node_type, label, connect_from, agent_id, prompt
- `update_node` — node_id, label, prompt, task_config
- `delete_node` — node_id
- `add_edge` — source, target, source_handle (true/false/loop/exit)
- `set_metadata` — name, chat_phrase, trigger_modes
- `publish`
- `trigger_workflow` — message

## Step types

trigger, agent, brain, ceo_approval, if, while, email, api, tool, parallel, merge

## Example

CEO: "Create a workflow: Brain drafts summary → CEO approves → if approved email tech team"

1. `create_workflow` with name + chat phrase
2. `add_node` brain, connect from trigger
3. `add_node` ceo_approval, connect from brain
4. `add_node` if (check ceo decision), `add_node` email on true branch
5. Confirm with CEO; `publish` when ready
