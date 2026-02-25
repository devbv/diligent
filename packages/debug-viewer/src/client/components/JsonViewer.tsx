import { darkStyles, JsonView } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";

interface JsonViewerProps {
  data: unknown;
  collapsed?: number;
}

const customStyles = {
  ...darkStyles,
  container: "json-viewer-container",
};

export function JsonViewer({ data, collapsed = 2 }: JsonViewerProps) {
  return <JsonView data={data} style={customStyles} shouldExpandNode={(level) => level < collapsed} />;
}
