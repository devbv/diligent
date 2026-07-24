// @summary Client app branding helpers sourced from Vite env with safe defaults

const DEFAULT_PROJECT_NAME = "Diligent";

function readProjectName(): string {
  const value = import.meta.env.VITE_APP_PROJECT_NAME;
  if (typeof value !== "string") return DEFAULT_PROJECT_NAME;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_PROJECT_NAME;
}

export const APP_PROJECT_NAME = readProjectName();
export const APP_PROJECT_MARK = APP_PROJECT_NAME.toUpperCase();
