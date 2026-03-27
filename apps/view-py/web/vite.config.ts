import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@view/view": resolve(__dirname, "../../../packages/view-react/src/index.ts"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
  },
});
