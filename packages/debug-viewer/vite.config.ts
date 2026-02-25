import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: ".",
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:7432",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:7432",
        ws: true,
      },
    },
  },
});
