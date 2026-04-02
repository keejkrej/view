# view

Shared viewer frontend focused on alignment and annotation workflows:

- `packages/core-ts`: shared viewer-domain types, grid/bbox math, and WebSocket client
- `packages/align`: reusable alignment canvas surface
- `packages/annotate`: reusable ROI annotation editor and canvas surface
- `packages/ui`: shared React web primitives and theme CSS for app shells
- `apps/tauri/src` + `apps/tauri/src-tauri`: Tauri desktop shell with a Rust WebSocket backend on `ws://127.0.0.1:47834`
- `apps/annotate-mock`: web-only harness for validating `@view/annotate`

Current Tauri flow:

- Select a workspace folder first. Bbox CSVs are written to `workspace/bbox/Pos{n}.csv`.
- Then open either a TIFF folder containing `Pos{n}` subfolders or an ND2 file.
- ROI annotations are edited through the reusable `@view/annotate` surface.

## Development

Tauri app:

```powershell
bun install
bun run dev
```

Annotate mock app:

```powershell
bun run dev:annotate-mock
```

## Verification

```powershell
bun run test
bun run typecheck
bun run build
cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml
```
