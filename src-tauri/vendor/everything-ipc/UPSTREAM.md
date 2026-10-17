# Maintained local patch: everything-ipc 0.1.4

- Upstream: https://github.com/Chaoses-Ib/IbEverythingLib/tree/858d0d4087e464fe55918ed38cd0e33402f985e7/everything-ipc
- Registry release: https://crates.io/crates/everything-ipc/0.1.4
- Original crate archive SHA256: `b6b15d96701388f017dff4afe0612956a8c8bab381b4684fa707432275d036c3`
- Original source: existing local Cargo registry cache; no new download or dependency installation.
- License: MIT, Copyright (c) 2025 Chaoses-Ib; complete notice retained in `LICENSE.txt`.

The upstream Rust source and manifests are retained. One production line is
added in `IpcWindow::with_instance`: append `_` before `(` for named instances,
matching the actual Everything 1.4/1.5 IPC class
`EVERYTHING_TASKBAR_NOTIFICATION_(name)` and upstream `instance_name()`.
The unnamed/default IPC class is unchanged. The root manifest uses a local
`[patch.crates-io]`; public APIs, features and version remain unchanged.

`tests/named_instance_regression.rs` is a standalone `rustc --test` harness. It
registers an invisible Win32 window with a unique named IPC class, exercises the
actual public lookup API, and destroys/unregisters its own fixture on completion.
An ignored test additionally checks an already running caller-owned named
Everything instance via `NIMBUS_IPC_VERIFY_INSTANCE`; it never starts or stops
Everything and never installs or changes a service.

Build the root dependency offline, then pass its generated rlib to the harness:

```text
cargo build --offline -p everything-ipc
rustc --edition=2024 --test vendor/everything-ipc/tests/named_instance_regression.rs --extern everything_ipc=target/debug/deps/libeverything_ipc-HASH.rlib -L dependency=target/debug/deps -o ../Temp/named-ipc-regression.exe
../Temp/named-ipc-regression.exe
```

Remove this patch when a verified upstream version fixes named instance lookup;
repeat the synthetic and caller-owned named instance tests before upgrading.
