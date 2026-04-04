# view

Layered viewer workspace focused on fast standalone development now and in-monorepo embedding later.

- `packages/contracts`: serializable viewer DTOs plus host/data ports
- `packages/core`: pure grid, bbox, selection, and contrast helpers
- `packages/react`: reusable React viewer module, including alignment and ROI annotation workflows
- `packages/host-tauri`: Tauri-specific adapter implementation of the host/data ports
- `packages/ui`: shared React web primitives and theme CSS for app shells
- `apps/desktop`: standalone desktop shell that composes `@view/react` through `@view/host-tauri`
- `crates/view-domain`: Rust domain types and workspace/file-path conventions
- `crates/view-image`: Rust TIFF/ND2 scanning, loading, and contrast shaping
- `crates/view-roi`: Rust ROI scanning, crop, bbox, and annotation persistence
- `crates/view-backend`: Rust façade consumed by the Tauri host

Current desktop flow:

- Select a workspace folder first. Bbox CSVs are written to `workspace/bbox/Pos{n}.csv`.
- Then open either a TIFF folder containing `Pos{n}` subfolders or an ND2 file.
- ROI annotations are edited through the reusable React viewer module.

## Development

Desktop app:

```powershell
bun install
bun run dev
```

## Verification

```powershell
bun run test
bun run typecheck
bun run build
cargo check --workspace
```
