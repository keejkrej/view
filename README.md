# view

Shared viewer frontend with two thin desktop wrapper families:

- `packages/view`: reusable viewer surface, viewer-domain types/utils, and WebSocket client
- `packages/shared/ui`: shared React web primitives and theme CSS for app shells
- `apps/view-rs/web` + `apps/view-rs/tauri`: Rust/Tauri wrapper with a Rust WebSocket backend on `ws://127.0.0.1:47834`
- `apps/view-py/web` + `apps/view-py/pyside6`: PySide6 wrapper with a Python WebSocket backend on `ws://127.0.0.1:47835`

`@view/view` no longer owns a packaged app shell or package-level CSS. The Tauri renderer now owns its controls/state locally and composes `ViewerCanvasSurface`, matching the PySide split where the host shell routes actions into the shared surface.

Current desktop flow:

- Select a workspace folder first. Bbox CSVs are written to `workspace/bbox/Pos{n}.csv`.
- Then open either a TIFF folder containing `Pos{n}` subfolders or an ND2 file.

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
