// @summary Reads, rotates, and summarizes Studio's EditLogging transaction files (human edits).

import { readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { decodeOvdrjm, isRecord } from "./ovdrjm-utils";

/**
 * Studio appends one JSON envelope per finalized human edit transaction.
 * Agent edits are never logged, so everything here is a genuine creator edit.
 * Studio recreates the file when it is missing, which is what makes the
 * rotate-and-delete consumption model safe.
 *
 * Current Studio builds write a single `Edit.Log` in the project root (next to
 * the .umap); the planned `Saved/EditLogging/` directory is scanned too so a
 * relocation doesn't break us.
 */
const ROOT_LOG_NAME = "edit.log";

export function editLoggingDir(cwd: string): string {
  return join(cwd, "Saved", "EditLogging");
}

/** Pending (and leftover `.consuming`) log files across both known locations. */
function listLogFiles(cwd: string): { pending: string[]; leftovers: string[] } {
  const pending: string[] = [];
  const leftovers: string[] = [];
  const scan = (dir: string, accept: (name: string) => boolean): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.endsWith(CONSUMING_SUFFIX)) leftovers.push(join(dir, name));
      else if (accept(name)) pending.push(join(dir, name));
    }
  };
  // Project root holds unrelated files, so only the exact log name is accepted there.
  scan(cwd, (name) => name.toLowerCase() === ROOT_LOG_NAME);
  scan(editLoggingDir(cwd), isEditLogName);
  return { pending, leftovers };
}

/** Suffix marking a log file rotated out of Studio's way but not yet deleted. */
const CONSUMING_SUFFIX = ".consuming";

const VALUE_MAX_CHARS = 120;
const MAX_SECTION_ENTRIES = 30;

export const TURN_START_HEADER = "Human edits since the agent's last completed turn:";
export const MID_TURN_HEADER = "Human edits made while this turn was in progress:";
export const NO_EDITS_MESSAGE = "No human edits detected since the agent's last completed turn.";

interface EditLogChange {
  property: string;
  before?: unknown;
  after?: unknown;
  added?: unknown[];
  removed?: unknown[];
  modified?: Array<{ before?: unknown; after?: unknown }>;
}

interface EditLogObject {
  guid: string;
  name?: string;
  type?: string;
  role?: string;
  action?: string;
  changes: EditLogChange[];
}

export interface EditLogEnvelope {
  timestamp: string;
  operation?: string;
  subjectGuids: string[];
  objects: EditLogObject[];
}

export interface EditLogBatch {
  envelopes: EditLogEnvelope[];
  parseFailures: number;
  /** Rotated files awaiting deletion once the summary is delivered. */
  consumedPaths: string[];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** First present key wins. Studio logs use PascalCase; docs and older builds used lowercase. */
function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * Tolerant field mapping. Real Studio logs (2026-08) use PascalCase throughout
 * (`Timestamp`/`Action`/`ActorGuids`/`Objects`/`Changes`/`Property`/`Added`);
 * the planning docs used lowercase plus `operation`/`subjectGuids`. Both are
 * accepted, along with ActorGuid/ObjectGuid naming drift.
 */
function toEnvelope(value: Record<string, unknown>): EditLogEnvelope | undefined {
  const rawObjects = (asArray(pick(value, "objects", "Objects")) ?? []).filter(isRecord);
  const objects: EditLogObject[] = [];
  for (const raw of rawObjects) {
    const guid = asString(pick(raw, "ActorGuid", "ObjectGuid"));
    if (!guid) continue;
    const changes: EditLogChange[] = [];
    for (const change of (asArray(pick(raw, "changes", "Changes")) ?? []).filter(isRecord)) {
      const property = asString(pick(change, "property", "Property"));
      if (!property) continue;
      changes.push({
        property,
        before: pick(change, "before", "Before"),
        after: pick(change, "after", "After"),
        added: asArray(pick(change, "added", "Added")),
        removed: asArray(pick(change, "removed", "Removed")),
        modified: asArray(pick(change, "modified", "Modified"))?.filter(isRecord),
      });
    }
    objects.push({
      guid,
      name: asString(pick(raw, "Name", "name")),
      type: asString(pick(raw, "InstanceType", "instanceType")),
      role: asString(pick(raw, "role", "Role")),
      action: asString(pick(raw, "action", "Action")),
      changes,
    });
  }
  if (objects.length === 0) return undefined;
  return {
    timestamp: asString(pick(value, "timestamp", "Timestamp")) ?? "",
    operation: asString(pick(value, "operation", "Operation", "action", "Action")),
    subjectGuids: [
      ...asStringArray(pick(value, "subjectGuids", "SubjectGuids")),
      ...asStringArray(pick(value, "ActorGuids", "ObjectGuids")),
    ],
    objects,
  };
}

/**
 * Split concatenated top-level JSON values (Studio appends pretty-printed
 * objects back to back — neither JSONL nor an array). Depth scan that respects
 * strings/escapes; a truncated trailing object is simply not emitted.
 */
function splitConcatenatedJson(text: string): string[] {
  const chunks: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        chunks.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return chunks;
}

/** Parse a log file's text: JSON array, single object, or concatenated objects (incl. JSONL). */
function parseEnvelopeText(text: string): { envelopes: EditLogEnvelope[]; failures: number } {
  const trimmed = text.trim();
  if (!trimmed) return { envelopes: [], failures: 0 };

  const collect = (values: unknown[]): { envelopes: EditLogEnvelope[]; failures: number } => {
    const envelopes: EditLogEnvelope[] = [];
    let failures = 0;
    for (const value of values) {
      const envelope = isRecord(value) ? toEnvelope(value) : undefined;
      if (envelope) envelopes.push(envelope);
      else failures++;
    }
    return { envelopes, failures };
  };

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return collect(Array.isArray(parsed) ? parsed : [parsed]);
  } catch {
    const chunks = splitConcatenatedJson(trimmed);
    const values: unknown[] = [];
    let failures = 0;
    for (const chunk of chunks) {
      try {
        values.push(JSON.parse(chunk));
      } catch {
        failures++;
      }
    }
    const result = collect(values);
    return { envelopes: result.envelopes, failures: result.failures + failures };
  }
}

function isEditLogName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".json") || lower.endsWith(".jsonl");
}

function readBatchFiles(paths: string[]): Omit<EditLogBatch, "consumedPaths"> {
  const envelopes: EditLogEnvelope[] = [];
  let parseFailures = 0;
  for (const path of paths) {
    let text: string;
    try {
      text = decodeOvdrjm(readFileSync(path));
    } catch {
      continue; // vanished or unreadable; nothing to report
    }
    const parsed = parseEnvelopeText(text);
    envelopes.push(...parsed.envelopes);
    parseFailures += parsed.failures;
  }
  // Stable sort keeps file/append order for equal or missing timestamps.
  envelopes.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { envelopes, parseFailures };
}

/**
 * Rotate live log files out of Studio's way and read everything pending.
 * Rename is atomic and Studio reopens the log per transaction, so an edit
 * landing after the rotation goes into a fresh file and is picked up next
 * turn — nothing is ever lost or double-consumed. Leftover `.consuming` files
 * from a crashed turn are included again (worst case a duplicate report).
 * Deletion is deferred to `deleteConsumed` so a crash before the summary is
 * delivered keeps the data on disk.
 */
export function rotateAndReadEditLogs(cwd: string): EditLogBatch {
  const { pending, leftovers } = listLogFiles(cwd);
  const consumedPaths = [...leftovers];

  let rotated = 0;
  for (const path of pending) {
    // Unique stamp so a leftover from a crashed turn is never clobbered.
    const dest = `${path}.${Date.now().toString(36)}-${rotated++}${CONSUMING_SUFFIX}`;
    try {
      renameSync(path, dest);
      consumedPaths.push(dest);
    } catch {
      // Studio may be mid-write on some platforms; the file stays and is retried next turn.
    }
  }

  return { ...readBatchFiles(consumedPaths), consumedPaths };
}

/** Read pending log files without rotating or deleting — safe mid-turn peek. */
export function peekEditLogs(cwd: string): Omit<EditLogBatch, "consumedPaths"> {
  return readBatchFiles(listLogFiles(cwd).pending);
}

export function deleteConsumed(paths: string[]): void {
  for (const path of paths) rmSync(path, { force: true });
}

/** Per-instance aggregate accumulated across all envelopes in a batch. */
interface TargetSummary {
  guid: string;
  name?: string;
  type?: string;
  created: boolean;
  removed: boolean;
  reparent?: { from?: string; to?: string };
  /** property -> earliest before / latest after across the batch. */
  props: Map<string, { before?: string; after?: string; count: number }>;
  /** list-typed property -> rendered delta lines. */
  lists: Map<string, { added: string[]; removed: string[]; modified: string[] }>;
  sourceEdits: number;
}

function formatValue(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "(none)");
  return text.length > VALUE_MAX_CHARS ? `${text.slice(0, VALUE_MAX_CHARS)}…` : text;
}

/** Render one element of a list delta: plain string, or {Name, InstanceType, ObjectGuid} reference. */
function formatListItem(item: unknown): string {
  if (isRecord(item)) {
    const name = asString(item.Name);
    const type = asString(item.InstanceType);
    if (name || type) return `${type ?? "Instance"} "${name ?? "?"}"`;
  }
  return formatValue(item);
}

/** Best-effort identity of a modified struct element (e.g. an Attribute's Key). */
function formatModifiedItem(item: { before?: unknown; after?: unknown }): string {
  const key =
    (isRecord(item.before) ? asString(item.before.Key) : undefined) ??
    (isRecord(item.after) ? asString(item.after.Key) : undefined);
  const label = key ? `"${key}": ` : "";
  return `${label}${formatValue(item.before)} -> ${formatValue(item.after)}`;
}

const CREATE_ACTION = /create/i;
const REMOVE_ACTION = /delete|remove|destroy/i;

/**
 * True for the records that carry the human's direct intent. Older logs have
 * no `role`; there, an envelope-level subject list is the fallback filter.
 */
function isSubject(object: EditLogObject, envelope: EditLogEnvelope): boolean {
  if (object.role === "auxiliary") return false;
  if (object.role === "subject") return true;
  if (envelope.subjectGuids.length > 0) return envelope.subjectGuids.includes(object.guid);
  return true;
}

function applyChange(target: TargetSummary, change: EditLogChange): void {
  if (change.property === "Source") {
    // 2026-08-10 decision: script edits log only "changed", never content.
    target.sourceEdits++;
    return;
  }
  if (change.property === "Parent" && (change.before !== undefined || change.after !== undefined)) {
    target.reparent = {
      from: target.reparent?.from ?? formatValue(change.before),
      to: formatValue(change.after),
    };
    return;
  }
  if (change.added || change.removed || change.modified) {
    let list = target.lists.get(change.property);
    if (!list) {
      list = { added: [], removed: [], modified: [] };
      target.lists.set(change.property, list);
    }
    for (const item of change.added ?? []) list.added.push(formatListItem(item));
    for (const item of change.removed ?? []) list.removed.push(formatListItem(item));
    for (const item of change.modified ?? []) list.modified.push(formatModifiedItem(item));
    return;
  }
  // Scalar before/after: collapse repeated edits (gizmo drags) to first-before -> last-after.
  const entry = target.props.get(change.property) ?? { count: 0 };
  if (entry.count === 0) entry.before = formatValue(change.before);
  entry.after = formatValue(change.after);
  entry.count++;
  target.props.set(change.property, entry);
}

function aggregate(envelopes: EditLogEnvelope[]): Map<string, TargetSummary> {
  const targets = new Map<string, TargetSummary>();
  for (const envelope of envelopes) {
    for (const object of envelope.objects) {
      if (!isSubject(object, envelope)) continue;
      let target = targets.get(object.guid);
      if (!target) {
        target = {
          guid: object.guid,
          created: false,
          removed: false,
          props: new Map(),
          lists: new Map(),
          sourceEdits: 0,
        };
        targets.set(object.guid, target);
      }
      target.name = object.name ?? target.name;
      target.type = object.type ?? target.type;
      const action = object.action ?? envelope.operation ?? "";
      if (CREATE_ACTION.test(action)) {
        target.created = true;
        target.removed = false; // re-created after a delete
      } else if (REMOVE_ACTION.test(action)) {
        target.removed = true;
      }
      for (const change of object.changes) applyChange(target, change);
    }
  }
  return targets;
}

function label(target: TargetSummary): string {
  return `${target.type ?? "Instance"} "${target.name ?? target.guid}" (${target.guid})`;
}

function detailLines(target: TargetSummary): string[] {
  const lines: string[] = [];
  for (const [property, entry] of target.props) {
    const times = entry.count > 1 ? ` (${entry.count} edits)` : "";
    lines.push(`  ${property}: ${entry.before} -> ${entry.after}${times}`);
  }
  for (const [property, delta] of target.lists) {
    if (delta.added.length > 0) lines.push(`  ${property}: added ${delta.added.join(", ")}`);
    if (delta.removed.length > 0) lines.push(`  ${property}: removed ${delta.removed.join(", ")}`);
    for (const item of delta.modified) lines.push(`  ${property}: modified ${item}`);
  }
  return lines;
}

function cappedSection(title: string, entries: string[]): string | undefined {
  if (entries.length === 0) return undefined;
  const shown = entries.slice(0, MAX_SECTION_ENTRIES);
  if (entries.length > MAX_SECTION_ENTRIES) shown.push(`(… ${entries.length - MAX_SECTION_ENTRIES} more)`);
  return `${title} (${entries.length}):\n${shown.join("\n")}`;
}

export interface EditLogSummary {
  output: string;
  editCount: number;
}

/**
 * Collapse a batch of edit-log envelopes into the compact per-section summary
 * injected into the agent's context. Section headers must stay in sync with
 * the web HumanEditsNotice count parser.
 */
export function summarizeEditLog(
  envelopes: EditLogEnvelope[],
  parseFailures = 0,
  header = TURN_START_HEADER,
): EditLogSummary {
  const targets = aggregate(envelopes);

  const added: string[] = [];
  const addedThenRemoved: string[] = [];
  const removed: string[] = [];
  const moved: string[] = [];
  const modified: string[] = [];
  const sourceChanged: string[] = [];

  for (const target of targets.values()) {
    if (target.created && target.removed) {
      addedThenRemoved.push(`± ${label(target)}`);
      continue;
    }
    if (target.created) {
      added.push([`+ ${label(target)}`, ...detailLines(target)].join("\n"));
      continue;
    }
    if (target.removed) {
      removed.push(`- ${label(target)}`);
      continue;
    }
    if (target.reparent) {
      moved.push(`> ${label(target)}: parent ${target.reparent.from} -> ${target.reparent.to}`);
    }
    const details = detailLines(target);
    if (details.length > 0) modified.push([`~ ${label(target)}`, ...details].join("\n"));
    if (target.sourceEdits > 0) {
      sourceChanged.push(
        `* ${label(target)}: source edited ${target.sourceEdits} time(s) — content is not logged; read the script for its current state`,
      );
    }
  }

  const sections = [
    cappedSection("Added", added),
    cappedSection("Added then removed", addedThenRemoved),
    cappedSection("Removed", removed),
    cappedSection("Moved", moved),
    cappedSection("Modified", modified),
    cappedSection("Script source changed", sourceChanged),
  ].filter((section): section is string => section !== undefined);

  const editCount =
    added.length + addedThenRemoved.length + removed.length + moved.length + modified.length + sourceChanged.length;
  if (editCount === 0) return { output: NO_EDITS_MESSAGE, editCount: 0 };

  const parts = [header, ...sections];
  if (parseFailures > 0) parts.push(`(${parseFailures} log entries could not be parsed and were skipped.)`);
  parts.push(
    "These are the creator's own edits. If any overlap with your current task, inspect the affected instances before editing them.",
  );
  return { output: parts.join("\n\n"), editCount };
}
