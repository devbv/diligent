// @summary Visual type icons for Studio instance and VS Code context chips

import { type AgentContextItem, getAgentContextItemVisualKind } from "../lib/agent-native-bridge";

function PlayersIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4 text-[#59677A]" aria-hidden="true">
      <circle cx="5" cy="4.75" r="2.25" fill="currentColor" />
      <path d="M1.25 12.75c0-2.35 1.55-4 3.75-4s3.75 1.65 3.75 4v.75h-7.5v-.75Z" fill="currentColor" />
      <circle cx="11.1" cy="4.25" r="1.8" fill="currentColor" />
      <path
        d="M9.1 8.55c.6-.45 1.3-.7 2.1-.7 2.05 0 3.55 1.55 3.55 3.8v.7H10.2a5.7 5.7 0 0 0-1.1-3.8Z"
        fill="currentColor"
      />
    </svg>
  );
}

function PlayerGuiIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" aria-hidden="true">
      <rect x="1.25" y="2.25" width="13.5" height="11.5" rx="1.5" stroke="#036FFC" strokeWidth="1.5" />
      <circle cx="8" cy="6.4" r="1.8" fill="#A3ACB5" />
      <path d="M4.8 11.3c.3-1.65 1.45-2.7 3.2-2.7s2.9 1.05 3.2 2.7H4.8Z" fill="#A3ACB5" />
    </svg>
  );
}

function ScriptIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4 text-[#FF28A9]" aria-hidden="true">
      <path
        d="M1.5 3.25c0-.7.55-1.25 1.25-1.25h3.1v1.3a1.65 1.65 0 1 0 3.3 0V2h4.1c.7 0 1.25.55 1.25 1.25v3.1h-1.3a1.65 1.65 0 1 0 0 3.3h1.3v3.1c0 .7-.55 1.25-1.25 1.25h-4.1v-1.3a1.65 1.65 0 1 0-3.3 0V14h-3.1c-.7 0-1.25-.55-1.25-1.25v-3.1h1.3a1.65 1.65 0 1 0 0-3.3h-1.3v-3.1Z"
        fill="currentColor"
      />
    </svg>
  );
}

function InstanceIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4 text-[#7C8793]" aria-hidden="true">
      <path d="m8 1.5 5.5 3.2v6.6L8 14.5l-5.5-3.2V4.7L8 1.5Z" stroke="currentColor" strokeWidth="1.4" />
      <path d="m2.8 4.9 5.2 3 5.2-3M8 8v6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function AtmosphereIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="#69A5D8" strokeWidth="1.5" />
      <path
        d="M3 8.25c1.35-2.8 3.3-3.9 5.25-3.2 1.55.55 1.65 2.3.45 3.15-1.1.75-2.35.15-2.2-.8"
        stroke="#69A5D8"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M5.1 11.6c2.45 1.15 5.4.25 6.8-2.15" stroke="#A3ACB5" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function LabelIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" aria-hidden="true">
      <path
        d="M8 1.25A5.25 5.25 0 0 0 2.75 6.5C2.75 10.2 8 14.75 8 14.75s5.25-4.55 5.25-8.25A5.25 5.25 0 0 0 8 1.25Z"
        fill="#29DCE5"
      />
      <circle cx="8" cy="6.4" r="1.65" fill="#155A67" />
    </svg>
  );
}

function SkeletonIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4 text-[#34D879]" aria-hidden="true">
      <circle cx="8" cy="4" r="3" fill="currentColor" />
      <circle cx="6.9" cy="3.7" r=".55" fill="#253038" />
      <circle cx="9.1" cy="3.7" r=".55" fill="#253038" />
      <path d="M4 8.1h8v6.4H4z" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 10.2h8M6.4 8.1v6.4M9.6 8.1v6.4" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

function VfxPresetIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4 text-[#F03DAA]" aria-hidden="true">
      <path d="M2 13.5 9.4 6.1l1.7 1.7-7.4 7.4L2 13.5Z" fill="currentColor" />
      <path
        d="m10.7 1 .7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7.7-2.1ZM4.5 2.8l.45 1.3 1.3.45-1.3.45-.45 1.3L4.05 5l-1.3-.45 1.3-.45.45-1.3Z"
        fill="currentColor"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4 text-[#7C8793]" aria-hidden="true">
      <path d="M3 1.5h6l4 4v9H3v-13Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M9 1.5v4h4M5.2 8h5.6M5.2 10.5h5.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function FileSelectionIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4 text-[#3191FF]" aria-hidden="true">
      <rect x="1.5" y="2.25" width="13" height="11.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="m4.4 6 1.9 1.7-1.9 1.7M7.8 9.4h3.3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ContextItemIcon({ item }: { item: AgentContextItem }) {
  const kind = getAgentContextItemVisualKind(item);
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center" data-context-icon={kind} aria-hidden="true">
      {kind === "players" ? <PlayersIcon /> : null}
      {kind === "player-gui" ? <PlayerGuiIcon /> : null}
      {kind === "script" ? <ScriptIcon /> : null}
      {kind === "atmosphere" ? <AtmosphereIcon /> : null}
      {kind === "label" ? <LabelIcon /> : null}
      {kind === "skeleton" ? <SkeletonIcon /> : null}
      {kind === "vfx-preset" ? <VfxPresetIcon /> : null}
      {kind === "instance" ? <InstanceIcon /> : null}
      {kind === "file" ? <FileIcon /> : null}
      {kind === "file-selection" ? <FileSelectionIcon /> : null}
    </span>
  );
}
