// @summary Provides the Vite SVGR import contract to Bun-based web component tests

import { plugin } from "bun";

plugin({
  name: "svg-react-test-loader",
  setup(build) {
    build.onLoad({ filter: /\.svg\?react$/ }, ({ path }) => {
      const iconName = path.match(/\/([^/?]+)\.svg(?:\?react)?$/)?.[1] ?? "svg-icon";

      return {
        loader: "js",
        contents: `
          import { createElement } from "react";

          export default function SvgIcon(props) {
            return createElement("svg", {
              viewBox: "0 0 24 24",
              focusable: "false",
              "aria-hidden": "true",
              ...props,
              "data-icon": ${JSON.stringify(iconName)},
            });
          }
        `,
      };
    });
  },
});
