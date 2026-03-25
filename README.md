# view

Shared viewer frontend with two thin desktop wrapper families:

- `packages/view`: reusable React app/component package and WebSocket client
- `apps/view-rs/web` + `apps/view-rs/tauri`: Rust/Tauri wrapper with a Rust WebSocket backend on `ws://127.0.0.1:47834`
- `apps/view-py/web` + `apps/view-py/pyside6`: PySide6 wrapper with a Python WebSocket backend on `ws://127.0.0.1:47835`

## Development

Tauri wrapper:

```powershell
bun install
bun run dev
```

PySide6 wrapper:

```powershell
bun install
uv run view-py
```

The Python host is exposed as a root `uv` script named `view-py`. It builds `apps/view-py/web` on demand and then loads the local `dist` bundle automatically.

## Verification

```powershell
bun run test
bun run typecheck
bun run build
cargo check --manifest-path apps/view-rs/tauri/Cargo.toml
cargo test --manifest-path apps/view-rs/tauri/Cargo.toml
```
