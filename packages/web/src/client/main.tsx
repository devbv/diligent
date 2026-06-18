// @summary React entrypoint mounting the Web CLI app and loading Tailwind/token styles
import "core-js/actual/array/at";
import "core-js/actual/array/find-last";
import "core-js/actual/array/find-last-index";
import "core-js/actual/object/has-own";
import "core-js/actual/string/at";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "highlight.js/styles/github-dark.css";
import "./styles/index.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
