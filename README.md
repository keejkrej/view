# view

Minimal high-performance viewer for `Pos{n}` TIFF workspaces, split into:

- `packages/pos-viewer`: reusable React viewer package
- `apps/tauri`: standalone Tauri shell using the same package

## Development

```powershell
bun install
bun run dev
```

## Verification

```powershell
bun run test
bun run typecheck
bun run build
bun run check:tauri
```
