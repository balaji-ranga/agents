import { formatStepIoFull, summarizeStepIo } from '../utils/workflowStepIo.js';
import HoverFixedTooltip from './HoverFixedTooltip.jsx';

function IoSections({ sections }) {
  if (!sections?.length) return <div className="wf-step-tooltip-meta">No data</div>;
  return sections.map((sec) => (
    <div key={sec.title} className="wf-step-tooltip-section">
      <div className="wf-step-tooltip-section-title">{sec.title}</div>
      <pre className="wf-step-tooltip-body">{sec.body}</pre>
    </div>
  ));
}

function StatusBadgeInline({ status }) {
  return (
    <span
      style={{
        fontSize: '0.65rem',
        padding: '2px 6px',
        borderRadius: 999,
        textTransform: 'uppercase',
        fontWeight: 600,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
      }}
    >
      {status}
    </span>
  );
}

function StepTooltipContent({ step }) {
  const inputSections = step.input ? formatStepIoFull(step.input, 'input') : null;
  const outputSections = step.output ? formatStepIoFull(step.output, 'output') : null;

  return (
    <>
      <div className="wf-step-tooltip-header">
        <span className="wf-step-tooltip-title">
          {step.node_label || step.node_id} <small>({step.node_type})</small>
        </span>
        <StatusBadgeInline status={step.status} />
      </div>
      {step.input && (
        <div className="wf-step-tooltip-block">
          <div className="wf-step-tooltip-label">Input</div>
          <IoSections sections={inputSections} />
        </div>
      )}
      {step.output && (
        <div className="wf-step-tooltip-block">
          <div className="wf-step-tooltip-label">Output</div>
          <IoSections sections={outputSections} />
        </div>
      )}
      {!step.input && !step.output && (
        <div className="wf-step-tooltip-meta">{summarizeStepIo(null)} — no I/O recorded yet</div>
      )}
      {step.error_message && <div className="wf-step-tooltip-error">{step.error_message}</div>}
    </>
  );
}

/** Hover tooltip with full step input/output for workflow run details. */
export default function WorkflowStepTooltip({ step, children }) {
  if (!step) return children;

  return (
    <HoverFixedTooltip
      as="li"
      className="wf-step-hover-wrap"
      tooltipClassName="wf-step-tooltip"
      placement="auto"
      content={<StepTooltipContent step={step} />}
    >
      {children}
    </HoverFixedTooltip>
  );
}

export function WorkflowIoDetailBlock({ title, io, kind }) {
  const sections = formatStepIoFull(io, kind);
  if (!sections?.length) return null;
  return (
    <div className="wf-io-detail-block">
      <div className="wf-io-detail-title">{title}</div>
      {sections.map((sec) => (
        <div key={sec.title}>
          <div className="wf-io-detail-subtitle">{sec.title}</div>
          <pre className="wf-io-detail-pre">{sec.body}</pre>
        </div>
      ))}
    </div>
  );
}
