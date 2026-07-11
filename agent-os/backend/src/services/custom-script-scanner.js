/**
 * Static security scan for user-submitted custom scripts (Python LangGraph / JavaScript).
 * Rejects hostile patterns before scripts can be approved for sandbox execution.
 * Combined with LLM review in custom-script-security-review.js (see CUSTOM_SCRIPT_LLM_REVIEW).
 */

const MAX_SCRIPT_BYTES = Number(process.env.CUSTOM_SCRIPT_MAX_BYTES) || 131072;

const SEVERITY = { critical: 'critical', high: 'high', medium: 'medium', low: 'low' };

const RULES = [
  { id: 'eval', pattern: /\beval\s*\(/i, severity: SEVERITY.critical, message: 'eval() is not allowed' },
  { id: 'exec', pattern: /\bexec\s*\(/i, severity: SEVERITY.critical, message: 'exec() is not allowed' },
  { id: 'compile', pattern: /\bcompile\s*\(/i, severity: SEVERITY.critical, message: 'compile() is not allowed' },
  { id: 'import_os', pattern: /\bimport\s+os\b|\bfrom\s+os\s+import/i, severity: SEVERITY.high, message: 'os module restricted — use sandbox APIs only' },
  { id: 'subprocess', pattern: /\bimport\s+subprocess\b|\bfrom\s+subprocess\s+import/i, severity: SEVERITY.critical, message: 'subprocess is not allowed' },
  { id: 'child_process', pattern: /require\s*\(\s*['"]child_process['"]\s*\)|from\s+['"]child_process['"]/i, severity: SEVERITY.critical, message: 'child_process is not allowed' },
  { id: 'fs_write', pattern: /writeFile|writeFileSync|unlinkSync|rmSync|rmdirSync/i, severity: SEVERITY.high, message: 'Filesystem write/delete is not allowed' },
  { id: 'socket', pattern: /\bimport\s+socket\b|\bfrom\s+socket\s+import/i, severity: SEVERITY.critical, message: 'socket is not allowed' },
  { id: 'ctypes', pattern: /\bimport\s+ctypes\b|\bfrom\s+ctypes\s+import/i, severity: SEVERITY.critical, message: 'ctypes is not allowed' },
  { id: 'pickle', pattern: /\bpickle\.loads?\s*\(/i, severity: SEVERITY.critical, message: 'pickle deserialization is not allowed' },
  { id: 'marshal', pattern: /\bmarshal\.loads?\s*\(/i, severity: SEVERITY.critical, message: 'marshal is not allowed' },
  { id: 'dunder_import', pattern: /__import__\s*\(/i, severity: SEVERITY.critical, message: '__import__ is not allowed' },
  { id: 'system_shell', pattern: /os\.system\s*\(|os\.popen\s*\(|shell\s*=\s*True/i, severity: SEVERITY.critical, message: 'Shell execution is not allowed' },
  { id: 'env_mutation', pattern: /process\.env\s*\[|process\.env\s*=/i, severity: SEVERITY.high, message: 'Environment mutation is not allowed' },
  { id: 'dynamic_import', pattern: /import\s*\(/i, severity: SEVERITY.high, message: 'Dynamic import() is not allowed' },
  { id: 'fetch_unrestricted', pattern: /\bfetch\s*\(|\baxios\b|\bhttp\.request\s*\(/i, severity: SEVERITY.medium, message: 'Network calls require network profile approval' },
  { id: 'requests_py', pattern: /\bimport\s+requests\b|\bfrom\s+requests\s+import/i, severity: SEVERITY.medium, message: 'requests library requires network profile approval' },
  { id: 'urllib', pattern: /\bimport\s+urllib\b|\bfrom\s+urllib/i, severity: SEVERITY.medium, message: 'urllib requires network profile approval' },
  { id: 'shutil_rmtree', pattern: /shutil\.rmtree|rmtree\s*\(/i, severity: SEVERITY.critical, message: 'Recursive delete is not allowed' },
  { id: 'infinite_loop', pattern: /while\s+True\s*:/i, severity: SEVERITY.medium, message: 'Unbounded while True — ensure timeout-safe logic' },
  { id: 'base64_exec', pattern: /atob\s*\(|Buffer\.from\s*\([^,]+,\s*['"]base64['"]\)/i, severity: SEVERITY.high, message: 'Obfuscated execution patterns are suspicious' },
];

const ENTRY_PYTHON = [/\bdef\s+run_graph\s*\(/, /\bdef\s+run\s*\(/, /\basync\s+def\s+run\s*\(/];
const ENTRY_JS = [
  /export\s+async\s+function\s+run\s*\(/,
  /export\s+function\s+run\s*\(/,
  /module\.exports\s*=\s*\{[^}]*\brun\b/,
  /module\.exports\.run\s*=/,
];

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

export function scanCustomScriptSource({ source, language = 'python', runtimeProfile = 'restricted' } = {}) {
  const code = String(source || '');
  const lang = String(language || 'python').toLowerCase();
  const profile = String(runtimeProfile || 'restricted').toLowerCase();

  const findings = [];

  if (!code.trim()) {
    return { passed: false, risk_level: 'critical', findings: [{ rule: 'empty', severity: 'critical', line: 1, message: 'Script is empty' }] };
  }

  if (Buffer.byteLength(code, 'utf8') > MAX_SCRIPT_BYTES) {
    findings.push({
      rule: 'size',
      severity: SEVERITY.critical,
      line: 1,
      message: `Script exceeds max size (${MAX_SCRIPT_BYTES} bytes)`,
    });
  }

  for (const rule of RULES) {
    if (profile === 'network' && ['fetch_unrestricted', 'requests_py', 'urllib'].includes(rule.id)) {
      continue;
    }
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');
    let m;
    while ((m = re.exec(code)) !== null) {
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        line: lineNumber(code, m.index),
        message: rule.message,
        snippet: code.slice(m.index, m.index + 60).replace(/\n/g, ' '),
      });
    }
  }

  const entryPatterns = lang === 'javascript' || lang === 'js' ? ENTRY_JS : ENTRY_PYTHON;
  const hasEntry = entryPatterns.some((p) => p.test(code));
  if (!hasEntry) {
    findings.push({
      rule: 'entrypoint',
      severity: SEVERITY.critical,
      line: 1,
      message:
        lang === 'javascript' || lang === 'js'
          ? 'Must export run(inputs, context) function'
          : 'Must define run_graph(inputs) or run(inputs) function',
    });
  }

  if (lang === 'python' && /\bfrom\s+langgraph\b|\bimport\s+langgraph\b/i.test(code)) {
    findings.push({
      rule: 'langgraph',
      severity: SEVERITY.low,
      line: 1,
      message: 'LangGraph import detected — will run in Python sandbox with langgraph if installed',
    });
  }

  const critical = findings.filter((f) => f.severity === SEVERITY.critical);
  const high = findings.filter((f) => f.severity === SEVERITY.high);
  const passed = critical.length === 0 && high.length === 0;

  let risk_level = 'low';
  if (critical.length) risk_level = 'critical';
  else if (high.length) risk_level = 'high';
  else if (findings.some((f) => f.severity === SEVERITY.medium)) risk_level = 'medium';

  return {
    passed,
    risk_level,
    runtime_profile: profile,
    language: lang,
    findings,
    scanned_at: new Date().toISOString(),
    byte_size: Buffer.byteLength(code, 'utf8'),
  };
}
