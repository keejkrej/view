# view

Shared viewer frontend with two thin desktop wrapper families:

- `packages/view-react`: reusable viewer surface, viewer-domain types/utils, and WebSocket client
- `packages/view-grid-ts`: pure TypeScript grid/bbox math shared by viewer shells
- `packages/ui`: shared React web primitives and theme CSS for app shells
- `apps/view-rs/src` + `apps/view-rs/src-tauri`: Rust/Tauri wrapper with a Rust WebSocket backend on `ws://127.0.0.1:47834`
- `apps/view-py/web` + `apps/view-py/src/view_py`: PySide6 wrapper with a Python WebSocket backend on `ws://127.0.0.1:47835`

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

The Python host is exposed through the `apps/view-py` workspace package as the `view-py` `uv` script. It builds `apps/view-py/web` on demand and then loads the local `dist` bundle automatically, so `uv run view-py` continues to work from the repository root.

## Verification

```powershell
bun run test
bun run typecheck
bun run build
cargo check --manifest-path apps/view-rs/src-tauri/Cargo.toml
cargo test --manifest-path apps/view-rs/src-tauri/Cargo.toml
```
