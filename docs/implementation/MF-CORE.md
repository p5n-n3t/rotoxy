# Oracle pool maintenance fence

The queue now stores a durable `pool_maintenance` singleton in the same SQLite database as tasks. Epoch/revision compare-and-swap requests pause claims; only the daemon claim transaction acknowledges after running, ambiguous, dispatching, and unknown-status blockers drain. Queued work remains queued. Release is an explicit epoch and revision CAS that resumes claims without restarting the pool or changing configuration. The fence never expires automatically.

`read_maintenance_status(db_path)` provides the admin a stable six-key DTO through a read-only SQLite connection. It validates the existing private database file/directory and schema; it never initializes a database or acknowledges maintenance. Missing or corrupt fence state fails closed as `maintenance_unavailable`. CLI commands `maintenance-status`, `maintenance-request`, and `maintenance-release` expose the same lifecycle for the trusted local operator.

Validation uses isolated temporary SQLite databases and fake transports; no Oracle host was contacted. Root integration can use the read-only helper for status and the pool APIs for explicit request/release. A future admin must not claim acknowledgement until the daemon has observed the drained fence.
