// @summary Centralizes class-bound instance property validation and schema-derived projection.

import { z } from "zod";
import { classPropertiesSchemas, classPropertyShapes, instanceClassEnum, type ShapeSpec } from "./instance.params";

const creatableClasses = new Set<string>(instanceClassEnum.options);

function classSchema(className: string): z.AnyZodObject {
  const schema = classPropertiesSchemas.get(className);
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(`Unsupported instance class: ${className}`);
  }
  return schema;
}

function propertyRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Instance properties must be an object.");
  }
  return value as Record<string, unknown>;
}

function formatIssues(className: string, error: z.ZodError): Error {
  return new Error(
    error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
        return `  [properties${path}] (class=${className}) ${issue.message}`;
      })
      .join("\n"),
  );
}

/** Validates a newly-created instance and returns schema defaults. */
export function parseInstanceCreateProperties(className: string, value: unknown): Record<string, unknown> {
  if (!creatableClasses.has(className)) {
    throw new Error(`Unsupported creatable instance class: ${className}`);
  }
  const result = classSchema(className).safeParse(propertyRecord(value));
  if (!result.success) throw formatIssues(className, result.error);
  return result.data;
}

/** Validates only supplied update keys and never injects create defaults. */
export function parseInstancePatchProperties(className: string, value: unknown): Record<string, unknown> {
  const raw = propertyRecord(value);
  const result = classSchema(className).partial().safeParse(raw);
  if (!result.success) throw formatIssues(className, result.error);
  return Object.fromEntries(Object.keys(raw).map((key) => [key, result.data[key]]));
}

function stripByShape(value: unknown, shape: ShapeSpec): unknown {
  if (shape === true) return value;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => stripByShape(item, shape));
  if (typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, childShape] of Object.entries(shape)) {
    if (key in record) result[key] = stripByShape(record[key], childShape);
  }
  return result;
}

/** Projects an .ovdrjm node to exactly the properties declared by its class schema. */
export function pickKnownInstanceProperties(className: string, node: Record<string, unknown>): Record<string, unknown> {
  const shapes = classPropertyShapes[className];
  if (!shapes) return {};

  const result: Record<string, unknown> = {};
  for (const [key, shape] of Object.entries(shapes)) {
    if (key in node) result[key] = stripByShape(node[key], shape);
  }
  return result;
}
