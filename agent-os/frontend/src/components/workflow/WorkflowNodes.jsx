import { Handle, Position } from '@xyflow/react';

const baseStyle = {
  padding: '10px 14px',
  borderRadius: 10,
  border: '2px solid var(--border)',
  background: 'var(--surface)',
  minWidth: 160,
  fontSize: '0.85rem',
  boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
  position: 'relative',
};

function NodeShell({ color, icon, title, subtitle, nodeId, handles = {}, children }) {
  return (
    <div style={{ ...baseStyle, borderColor: color }}>
      {handles.target !== false && <Handle type="target" position={Position.Left} style={{ background: color }} />}
      <div style={{ fontWeight: 700, color, marginBottom: 4 }}>
        {icon} {title}
      </div>
      {nodeId && (
        <div
          style={{
            fontFamily: 'ui-monospace, monospace',
            fontSize: '0.65rem',
            color: 'var(--muted)',
            marginBottom: subtitle ? 2 : 4,
          }}
        >
          {nodeId}
        </div>
      )}
      {subtitle && <div style={{ color: 'var(--muted)', fontSize: '0.75rem' }}>{subtitle}</div>}
      {children}
      {handles.source !== false && !handles.multiSource && (
        <Handle type="source" position={Position.Right} style={{ background: color }} />
      )}
    </div>
  );
}

export function TriggerNode({ id, data }) {
  const modes = (data.triggerModes || ['manual']).join(', ');
  return (
    <NodeShell
      nodeId={id}
      color="#16a34a"
      icon="▶"
      title={data.label || 'Trigger'}
      subtitle={`${modes}${data.scheduleCron ? ` · ${data.scheduleCron}` : ''}`}
      handles={{ target: false }}
    />
  );
}

export function AgentNode({ id, data }) {
  return (
    <NodeShell
      nodeId={id}
      color="#2563eb"
      icon="🤖"
      title={data.label || 'Agent'}
      subtitle={data.agentName || data.agentId || 'Select agent'}
    />
  );
}

export function ToolNode({ id, data }) {
  return (
    <NodeShell nodeId={id}
      color="#9333ea"
      icon="🔧"
      title={data.label || 'Tool'}
      subtitle={data.toolName || 'Select content tool'}
    />
  );
}

export function EmailNode({ id, data }) {
  const to = data.inputBindings?.find((b) => b.id === 'to')?.value || '(configure To)';
  return (
    <NodeShell nodeId={id} color="#dc2626" icon="✉" title={data.label || 'Send Email'} subtitle={`To: ${to}`} />
  );
}

export function ApiNode({ id, data }) {
  const url = data.inputBindings?.find((b) => b.id === 'url')?.value || data.taskConfig?.url || '(configure URL)';
  return (
    <NodeShell nodeId={id} color="#7c3aed" icon="⇄" title={data.label || 'Call API'} subtitle={String(url).slice(0, 40)} />
  );
}

export function ParallelNode({ id, data }) {
  return (
    <NodeShell nodeId={id} color="#ea580c" icon="⑂" title={data.label || 'Parallel'} subtitle="Run branches concurrently" />
  );
}

export function MergeNode({ id, data }) {
  return (
    <NodeShell nodeId={id} color="#0891b2" icon="⊕" title={data.label || 'Merge'} subtitle="Wait for all inputs" />
  );
}

export function CeoApprovalNode({ id, data }) {
  return (
    <NodeShell
      nodeId={id}
      color="#ca8a04"
      icon="👤"
      title={data.label || 'CEO Approval'}
      subtitle="Kanban · approve / reject"
    />
  );
}

export function IfNode({ id, data }) {
  const cfg = data.taskConfig || {};
  const sourceLabel = cfg.sourceNodeId || 'pick source step';
  return (
    <NodeShell nodeId={id} color="#0d9488" icon="◇" title={data.label || 'IF'} subtitle={`${cfg.operator || '?'} · ${sourceLabel}`} handles={{ multiSource: true }}>
      <Handle type="source" position={Position.Right} id="true" style={{ top: '35%', background: '#16a34a' }} />
      <Handle type="source" position={Position.Right} id="false" style={{ top: '65%', background: '#dc2626' }} />
      <div style={{ fontSize: '0.65rem', color: 'var(--muted)', marginTop: 4 }}>
        <span style={{ color: '#16a34a' }}>T</span> / <span style={{ color: '#dc2626' }}>F</span>
      </div>
    </NodeShell>
  );
}

export function WhileNode({ id, data }) {
  const cfg = data.taskConfig || {};
  return (
    <NodeShell
      nodeId={id}
      color="#db2777"
      icon="↻"
      title={data.label || 'While'}
      subtitle={`max ${cfg.maxIterations ?? 10}`}
      handles={{ multiSource: true }}
    >
      <Handle type="source" position={Position.Right} id="loop" style={{ top: '35%', background: '#db2777' }} />
      <Handle type="source" position={Position.Right} id="exit" style={{ top: '65%', background: '#6366f1' }} />
      <div style={{ fontSize: '0.65rem', color: 'var(--muted)', marginTop: 4 }}>loop / exit</div>
    </NodeShell>
  );
}

export function BrainNode({ id, data }) {
  const cfg = data.taskConfig || {};
  return (
    <NodeShell
      nodeId={id}
      color="#6366f1"
      icon="🧠"
      title={data.label || 'Brain'}
      subtitle={`${cfg.modelSource || 'openai'} · ${cfg.model || 'model'}`}
    />
  );
}

export const workflowNodeTypes = {
  trigger: TriggerNode,
  agent: AgentNode,
  tool: ToolNode,
  email: EmailNode,
  api: ApiNode,
  parallel: ParallelNode,
  merge: MergeNode,
  ceo_approval: CeoApprovalNode,
  if: IfNode,
  while: WhileNode,
  brain: BrainNode,
};

export const PALETTE_ITEMS = [
  { type: 'trigger', label: 'Trigger', color: '#16a34a', desc: 'Start point (manual / schedule / chat)' },
  { type: 'agent', label: 'Agent', color: '#2563eb', desc: 'Delegate to workspace agent' },
  { type: 'brain', label: 'Brain (LLM)', color: '#6366f1', desc: 'Direct LLM call (OpenAI / Anthropic / Ollama)' },
  { type: 'ceo_approval', label: 'CEO Approval', color: '#ca8a04', desc: 'Human approve/reject on Kanban' },
  { type: 'if', label: 'IF', color: '#0d9488', desc: 'Branch on condition (true/false handles)' },
  { type: 'while', label: 'While', color: '#db2777', desc: 'Loop while condition (loop/exit handles)' },
  { type: 'email', label: 'Send Email', color: '#dc2626', desc: 'SMTP email with static + dynamic inputs' },
  { type: 'api', label: 'Call API', color: '#7c3aed', desc: 'HTTP request with configurable URL/body' },
  { type: 'tool', label: 'Content Tool', color: '#9333ea', desc: 'Invoke a content tool' },
  { type: 'parallel', label: 'Parallel', color: '#ea580c', desc: 'Fan-out to multiple branches' },
  { type: 'merge', label: 'Merge', color: '#0891b2', desc: 'Join parallel branches' },
];

export function defaultNodeData(type, extra = {}) {
  const id = extra.id || `${type}-${Date.now().toString(36)}`;
  let data = { label: PALETTE_ITEMS.find((p) => p.type === type)?.label || type };
  if (type === 'trigger') {
    data = { ...data, triggerModes: ['manual'], scheduleCron: '', chatPhrase: '' };
  }
  if (type === 'agent') {
    data = { ...data, agentId: '', agentName: '', prompt: 'Complete this task:\n\n{{input}}', inputFrom: '' };
  }
  if (type === 'tool') {
    data = { ...data, toolName: '', toolPayload: {} };
  }
  if (type === 'email' || type === 'api' || type === 'brain' || type === 'ceo_approval') {
    data = { ...data, inputBindings: [], outputs: [], taskConfig: {} };
  }
  if (type === 'if' || type === 'while') {
    data = {
      ...data,
      taskConfig: {
        sourceNodeId: '',
        sourceOutputKey: 'text',
        operator: type === 'while' ? 'not_empty' : 'contains',
        compareValue: '',
        maxIterations: 10,
      },
    };
  }
  if (type === 'brain') {
    data.taskConfig = {
      modelSource: 'ollama',
      apiEndpoint: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: 'llama3.2',
      maxTokens: 512,
      systemPrompt: 'You are a concise assistant.\n\nContext:\n{{input}}',
      mcpEndpoints: '[]',
    };
  }
  if (type === 'ceo_approval') {
    data.taskConfig = { title: 'CEO Approval Required', instructions: 'Review the summary and approve or reject.' };
  }
  if (extra.data) data = { ...data, ...extra.data };
  return {
    id,
    type,
    position: extra.position || { x: 100 + Math.random() * 200, y: 100 + Math.random() * 100 },
    data,
  };
}

export function graphToFlow(graph) {
  return {
    nodes: (graph?.nodes || []).map((n) => ({
      ...n,
      type: n.type || 'agent',
    })),
    edges: (graph?.edges || []).map((e) => ({
      ...e,
      animated: true,
      style: { stroke: 'var(--accent)' },
      label: e.sourceHandle === 'true' ? 'T' : e.sourceHandle === 'false' ? 'F' : e.sourceHandle === 'loop' ? 'loop' : e.sourceHandle === 'exit' ? 'exit' : undefined,
    })),
    viewport: graph?.viewport || { x: 0, y: 0, zoom: 1 },
  };
}

export function flowToGraph(nodes, edges, viewport) {
  return {
    nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position, data })),
    edges: edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({
      id,
      source,
      target,
      sourceHandle: sourceHandle || undefined,
      targetHandle: targetHandle || undefined,
    })),
    viewport,
  };
}
