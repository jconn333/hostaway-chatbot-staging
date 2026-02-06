# ADR 0003: Model-First Orchestration With Deterministic Guardrails

## Status
Accepted

## Context
The chatbot accumulated phrase-based intent ladders and route-specific condition trees. This produced brittle behavior under natural phrasing diversity and long-tail follow-ups. We need a design where the model interprets intent and tool usage, while deterministic code enforces correctness, safety, and policy.

## Decision
Adopt a model-first orchestration loop as the primary execution path for `POST /chat`.

### Architecture
1. The model receives:
   - A strict system prompt contract.
   - Session context.
   - A machine-usable tool catalog with strict schemas.
2. The orchestrator loop executes:
   - Call model.
   - If function calls exist, validate args by schema.
   - Apply policy gates (role allowlist, confirmation gate, read-only model).
   - Execute tools with retry + timeout.
   - Append tool outputs and continue until final assistant message.
3. If validation fails or inputs are missing, return one concise clarification question.

### Deterministic guardrails
- Max tool calls per turn.
- Circuit breaker for repeated tool execution failures.
- Tool allowlist by user role.
- Strict schema validation before execution.
- Read-only backend toolset.

### Observability
Each turn logs:
- Model decision (tool(s) requested).
- Validation result.
- Execution result.
- Failure reason where present.

## Consequences
### Positive
- Better handling of natural language diversity.
- Reduced intent overfitting in business logic.
- Strong safety and operational controls remain deterministic.
- Better debugging via explicit orchestration trace.

### Negative
- Higher dependence on model tool-call quality.
- Requires robust schema/prompt maintenance.
- New orchestration path adds operational complexity.

## Rollback Runbook
1. Set `MODEL_FIRST_ORCHESTRATOR=false` in runtime environment.
2. Restart the service (or redeploy) so `/chat` uses the legacy path.
3. Verify rollback via `POST /chat` with test mode:
   1. Send `X-Test-Mode: 1` header.
   2. Confirm response does **not** include `meta.orchestration`.
   3. Confirm expected legacy reply behavior for a known golden-core prompt.
4. Run validation commands:
   1. `npm test`
   2. `npm run golden:core` (or staging subset if Hostaway is unavailable in CI)
5. Log rollback event with:
   1. timestamp
   2. code version
   3. reason for rollback
6. Keep model-first code intact behind flag until fix is verified and re-enabled.

## Non-Goals
- Expanding regex/keyword route ladders.
- Adding write-capable external actions.
