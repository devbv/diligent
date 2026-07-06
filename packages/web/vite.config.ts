// @summary Vite config for React client build with dev proxy to backend RPC
import legacy from "@vitejs/plugin-legacy";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import svgr from "vite-plugin-svgr";
import { WEB_IMAGE_ROUTE_PREFIX } from "./src/shared/image-routes";

const DEFAULT_PROJECT_NAME = "Diligent";
const BACKEND_HTTP_TARGET = "http://localhost:7433";
const BACKEND_WS_TARGET = "ws://localhost:7433";

export default defineConfig(({ mode }) => ({
  plugins: [
    svgr(),
    {
      name: "raw-md",
      transform(code, id) {
        if (id.endsWith(".md")) {
          return `export default ${JSON.stringify(code)};`;
        }
      },
    },
    {
      name: "app-project-name",
      transformIndexHtml(html) {
        const projectName = process.env.VITE_APP_PROJECT_NAME?.trim() || DEFAULT_PROJECT_NAME;
        return html.replace(/%VITE_APP_PROJECT_NAME%/g, projectName);
      },
    },
    react(),
    legacy({
      targets: ["chrome >= 90"],
    }),
  ],
  build: {
    outDir: "dist/client",
    minify: mode === "development" ? false : "esbuild",
  },
  server: {
    port: 5174,
    proxy: {
      "/rpc": {
        target: BACKEND_WS_TARGET,
        ws: true,
      },
      [WEB_IMAGE_ROUTE_PREFIX]: {
        target: BACKEND_HTTP_TARGET,
      },
    },
  },
}));
