import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@view/shared-ui/theme.css": resolve(__dirname, "../../packages/shared/ui/src/theme.css"),
      "@view/shared-ui": resolve(__dirname, "../../packages/shared/ui/src/index.ts"),
      "@view/view": resolve(__dirname, "../../packages/view/src/index.ts"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
