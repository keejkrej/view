import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@view/pos-viewer": resolve(__dirname, "../../packages/pos-viewer/src/index.ts"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
