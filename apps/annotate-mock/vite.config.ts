import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@view/annotate": resolve(__dirname, "../../packages/annotate/src/index.ts"),
      "@view/core-ts": resolve(__dirname, "../../packages/core-ts/src/index.ts"),
      "@view/ui": resolve(__dirname, "../../packages/ui/src/index.ts"),
      "@view/ui/theme.css": resolve(__dirname, "../../packages/ui/src/theme.css"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
});
