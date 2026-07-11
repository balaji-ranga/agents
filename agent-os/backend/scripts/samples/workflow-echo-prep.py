"""
Sample custom workflow script — reads trigger input + prior node outputs from context,
prepares JSON body for downstream Echo API calls inside a While loop.

Entrypoint: run_graph(inputs, context)
"""
import json


def run_graph(inputs, context=None):
    ctx = context or {}
    node_outputs = ctx.get("node_outputs") or {}

    trigger_text = (
        inputs.get("text")
        or inputs.get("payload")
        or inputs.get("trigger_input")
        or ""
    )
    trigger_snapshot = node_outputs.get("trigger-1") or {}
    if not trigger_text and isinstance(trigger_snapshot, dict):
        trigger_text = trigger_snapshot.get("text") or trigger_snapshot.get("trigger_input") or ""

    echo_rounds = 3
    payload = {
        "message": str(trigger_text),
        "echo_rounds": echo_rounds,
        "workflow_id": ctx.get("workflow"),
        "run_id": ctx.get("run_id"),
        "prepared_by": "workflow-echo-prep-script",
    }

    return {
        "text": json.dumps(payload),
        "echo_iterations": echo_rounds,
        "summary": f"Prepared {echo_rounds} echo calls for: {trigger_text!r}",
        "ok": True,
    }
