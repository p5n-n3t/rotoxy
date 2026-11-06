# Codex durable worker integration

Source implementation uses the official installed Codex App Server. The generated
0.166.0 protocol schema supplies account/read, model/list and thread/turn contracts.
The gateway stores a hash of the reported account identity. Account secrets stay
inside each isolated CODEX_HOME.

The main DAG accepts provider codex with an explicit profile, model, effort,
complexity and originSessionId. The authenticated OAuth client and the operator's
session binding determine native-account protection. Subject identity is refreshed
and compared again before thread creation. The existing operator pool policy and
per-model effort availability also apply. Free-account routing retains the
conservative routine/Luna restriction.

An existing StateStore transaction records the immutable operation intent before
any native launch. Thread ownership and thread/turn receipts persist before later
mutations. Existing intents and ambiguous results require reconciliation. They
cannot start another turn automatically. Successful results require the expected
model, effort, profile, size and final marker, plus a workspace artifact. The
Python scheduler checks these bindings independently and owns account capacity.

Worker participants carry the profile label, provider and model in the workspace.
Pending native approvals are recorded by request ID and method. The current
read-only adapter interrupts that turn, records a blocked task and retains the
ambiguous reservation for review. Interactive approval/resume is a remaining
extension. Server support alone cannot awaken an inactive ChatGPT conversation.

The admin page provides pool/profile enablement and native-session binding and
closure. Bindings last twelve hours. An expired open binding continues protecting
its account until the operator closes it. Worker execution requires an explicitly
configured ROTOXY_CODEX_WORKER_CWD and uses the read-only no-network sandbox.
The adapter caps effective concurrency at one turn per profile. The deterministic
scheduler enforces job/account/global ceilings.

Local evidence before release

- Existing focused Node suites passed41 tests.
- New adapter controls and real Python DAG/workspace integration passed8 tests.
- Broader worker/runtime focused run passed51 tests before final attribution and
  approval hardening. Final release checks must be recorded below.
- Python scheduler job suites passed100 tests before the small max/ultra effort
  catalog extension. Model effort membership remains checked per exact model.
- Metadata-only probing returned three Plus and two Free snapshots. Two profiles
  did not return complete account/model/quota metadata. No inference was launched
  by those probes. Reported quota windows keep their provider denominators.

Live inference, deployed SHA, restart checks and full CI are pending.
