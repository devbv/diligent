// @summary Uppercase monospace section label for tool input/output and card headers

import { microLabelClasses } from "./ui-styles";

interface SectionLabelProps {
  children: React.ReactNode;
}

export function SectionLabel({ children }: SectionLabelProps) {
  return <div className={`mb-2 ${microLabelClasses}`}>{children}</div>;
}
