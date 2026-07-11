export const BRAIN_PROVIDER_PRESETS = {
  openai: {
    label: 'OpenAI',
    apiEndpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKeyHint: 'sk-... (required on node)',
  },
  anthropic: {
    label: 'Anthropic',
    apiEndpoint: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-20250514',
    apiKeyHint: 'sk-ant-... (required on node)',
  },
  ollama: {
    label: 'Ollama (local)',
    apiEndpoint: 'http://127.0.0.1:11434/v1',
    model: 'llama3.2',
    apiKeyHint: 'optional for local Ollama',
  },
  openrouter: {
    label: 'OpenRouter',
    apiEndpoint: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    apiKeyHint: 'sk-or-... (required on node)',
    httpReferer: '',
    siteTitle: 'Agent OS',
  },
};

/** Client-side mirror of standard task I/O (also fetched from API). */
export const TASK_TYPES = {
  trigger: { label: 'Trigger', color: '#16a34a', icon: '▶' },
  agent: { label: 'Agent', color: '#2563eb', icon: '🤖' },
  tool: { label: 'Content Tool', color: '#9333ea', icon: '🔧' },
  email: { label: 'Send Email', color: '#dc2626', icon: '✉' },
  api: { label: 'Call API', color: '#7c3aed', icon: '⇄' },
  parallel: { label: 'Parallel', color: '#ea580c', icon: '⑂' },
  merge: { label: 'Merge', color: '#0891b2', icon: '⊕' },
};

export function defaultInputBindingsFromCatalog(taskType, catalogEntry) {
  if (!catalogEntry?.inputs?.length) return [];
  return catalogEntry.inputs.map((inp) => ({
    id: inp.id,
    label: inp.label,
    mode: inp.defaultMode || inp.mode || 'static',
    value: '',
    sourceNodeId: '',
    sourceOutputKey: inp.id === 'body' ? 'text' : 'text',
  }));
}

export function defaultTaskConfigFromCatalog(catalogEntry) {
  const config = {};
  for (const f of catalogEntry?.configFields || []) {
    config[f.id] = f.default ?? (f.type === 'boolean' ? false : '');
  }
  return config;
}
