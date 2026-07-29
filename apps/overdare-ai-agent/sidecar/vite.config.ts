// @summary Vite config for React client build with dev proxy to backend RPC
import { sentryVitePlugin } from "@sentry/vite-plugin";
import legacy from "@vitejs/plugin-legacy";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import svgr from "vite-plugin-svgr";
import { WEB_IMAGE_ROUTE_PREFIX } from "./src/web/shared/image-routes";

// Sentry source-map upload runs only in CI release builds, gated on the auth token
// (release.yml sets SENTRY_AUTH_TOKEN + SENTRY_RELEASE). SENTRY_RELEASE must stay the
// bare bundle version — it has to match the release the server injects at runtime
// (DILIGENT_SERVER_VERSION, see src/web/server/index.ts).
const SENTRY_UPLOAD = Boolean(process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_RELEASE);

const DEFAULT_PROJECT_NAME = "Diligent";
const BACKEND_HTTP_TARGET = "http://127.0.0.1:7433";
const BACKEND_WS_TARGET = "ws://127.0.0.1:7433";

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
    ...(SENTRY_UPLOAD
      ? [
          sentryVitePlugin({
            org: "overdare",
            project: "diligent-agent",
            release: { name: process.env.SENTRY_RELEASE },
            sourcemaps: {
              // Maps are only needed by Sentry; keep them out of the shipped bundle.
              filesToDeleteAfterUpload: ["dist/client/**/*.map"],
            },
          }),
        ]
      : []),
  ],
  build: {
    outDir: "dist/client",
    minify: mode === "development" ? false : "esbuild",
    // "hidden" emits maps for the Sentry upload without sourceMappingURL comments.
    sourcemap: SENTRY_UPLOAD ? "hidden" : false,
  },
  server: {
    host: true,
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
