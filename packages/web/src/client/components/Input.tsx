// @summary Text input component with consistent focus ring and semantic surface styles
import type { InputHTMLAttributes } from "react";
import { cn } from "../lib/cn";
import { fieldClasses } from "./ui-styles";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn("h-10", fieldClasses, props.className)} />;
}
