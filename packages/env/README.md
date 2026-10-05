# @earendil-works/pi-env

Remote execution environments for [Pi Durable](../durable): an agent's tools run on another machine, usually over SSH,
while the Durable worker, its storage and credentials stay local.

- `pi-env` (`daemon/`): a small Rust program that runs on the remote machine. It speaks a framed protocol on stdin and
  stdout ([docs/protocol.md](docs/protocol.md)) and performs file operations and commands there.
- `RemoteExecutionEnv`: a Durable `ExecutionEnv` that talks to the daemon through a `Connection`. Its results match
  `NodeExecutionEnv` running on the remote machine; only error messages may differ
  ([docs/semantics.md](docs/semantics.md)).

```ts
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";

const connection = new Connection({ command: ["ssh", "-T", "--", "gpu-box", "~/.pi/mobile/tools/pi-env"] });
const env = new RemoteExecutionEnv({ connection, id: "pi-env:gpu-box", cwd: "/home/me/project" });
```

Supported remote systems: Linux, macOS, Android (Termux) and Windows, on x86-64 and arm64. On Windows, string commands
run through Git Bash as `NodeExecutionEnv` runs them there; argv commands run directly.

## Development

`npm run build:daemon` builds the daemon with Cargo; the tests talk to `daemon/target/debug/pi-env` over a pipe. They
run Durable's env conformance suite against `RemoteExecutionEnv` and compare random operation sequences and Durable's
tools against `NodeExecutionEnv` on the same machine.

Not yet: SSH bootstrap and binary deployment, output windowing (all output is transferred), daemon-side file watching
(the client polls).
