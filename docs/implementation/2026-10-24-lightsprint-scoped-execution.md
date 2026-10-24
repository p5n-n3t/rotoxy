# LightSprint scoped execution verification — 2026-10-24

## Verified behavior

- The scoped transport is credential-pinned, validates its workspace against that
  credential's current catalog, and preserves the global raw-MCP endpoint policy.
- Task instructions are independently read back before launch. Automatic merge is
  disabled. A consumed instruction binding cannot authorize a repeated or
  concurrent launch. Durable callers must still reserve before attempting a POST.
- Scoped status reads succeeded on l2thepete and ecummi16.
- Workspace stacks and canonical repository membership were read independently on
  maryjoebake and jqthefoo.
- A bounded control invocation created a read-only task and launched one session
  on each of those two newly connected accounts. Both produced complete assistant
  responses with the requested completion markers. Native status confirmed
  ownership and reported `gpt-6.1-sol`.
- jqthefoo reported USD 0.225696 session cost; maryjoebake reported USD 0.24136.
  These are provider-reported session amounts, not verified credit deductions or
  actual monetary charges. No top-up or purchase was performed.
- The jqthefoo session was registered with the existing shared Fleet dispatcher.
  Claude Code then discovered it through ordinary OAuth-authenticated MCP and
  submitted `jqthefoo-mcp-reuse-20261024-01`. The durable result contains its marker,
  624 characters of output and the reported model `gpt-6.1-sol`.

## Recovery evidence

The first create attempts on both accounts were locally rejected before execution
because catalog binding validation failed. Separate denied dry validation
subsequently confirmed their bindings. Those known refusals were retried in a
separate, exclusive intent-journal directory. No possibly accepted mutation was
retried.

The maryjoebake session initially returned 404 for status/transcript during
startup. A read-only task-scoped lookup confirmed the same session ID and task
association. Later status/transcript reads succeeded without relaunching it.

Intent/outcome journals are owner-private outside the repository. They are opened
exclusively and synced before mutations. They are diagnostic evidence and are not
a substitute for the production scheduler's durable task and operation ledgers.

## Acceptance limits

- A response accepting a launch is distinct from verified execution and output.
  Both outputs were checked against the latest assistant response, not the prompt.
- Available timestamps do not prove overlapping active inference; no concurrency
  figure is claimed from simultaneous launch requests or startup states.
- The API's launch does not establish exact model/effort selection. The model above
  was observed after execution, not requested or guaranteed.
- Fresh account provisioning is not yet a production `job_submit` operation.
  This verification exercised the scoped adapter under explicit local permission.
- The provider-session identifier compatibility change is covered locally but
  still requires runtime activation before the leading-underscore maryjoebake
  session can be registered for reuse.
- The Desktop ROTOXY connector returned internal errors. Local Claude Code's
  ordinary OAuth-authenticated ROTOXY MCP connection succeeded independently.

## Checks

The scoped adapter and existing adapter/discovery/helper focused run passed 61
tests. The subsequent safe base64url helper change passed 34 focused tests. Full
CI passed for commits `2726ec9` and `de044d9`. Additional runtime compatibility
changes must be independently tested before deployment.
