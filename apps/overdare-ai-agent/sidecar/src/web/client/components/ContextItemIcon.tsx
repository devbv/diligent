// @summary SVGR-backed visual type icons for Studio instance and VS Code context chips

import type { ComponentType, SVGProps } from "react";
import AtmosphereIconAsset from "../icons/context-atmosphere.svg?react";
import FileIconAsset from "../icons/context-file.svg?react";
import FileSelectionIconAsset from "../icons/context-file-selection.svg?react";
import InstanceIconAsset from "../icons/context-instance.svg?react";
import LabelIconAsset from "../icons/context-label.svg?react";
import PlayerGuiIconAsset from "../icons/context-player-gui.svg?react";
import PlayersIconAsset from "../icons/context-players.svg?react";
import ScriptIconAsset from "../icons/context-script.svg?react";
import SkeletonIconAsset from "../icons/context-skeleton.svg?react";
import VfxPresetIconAsset from "../icons/context-vfx-preset.svg?react";
import {
  type AgentContextItem,
  type AgentContextItemVisualKind,
  getAgentContextItemVisualKind,
} from "../lib/agent-native-bridge";
import { cn } from "../lib/cn";

type ContextIconComponent = ComponentType<SVGProps<SVGSVGElement>>;

interface ContextIconConfig {
  Icon: ContextIconComponent;
  className?: string;
}

function createContextIcon(component: unknown, name: string): ContextIconComponent {
  if (typeof component === "function") return component as ContextIconComponent;

  return function ContextIconFallback(props: SVGProps<SVGSVGElement>) {
    return <svg viewBox="0 0 16 16" fill="none" focusable="false" aria-hidden="true" {...props} data-icon={name} />;
  };
}

const CONTEXT_ICON_CONFIG: Record<AgentContextItemVisualKind, ContextIconConfig> = {
  players: {
    Icon: createContextIcon(PlayersIconAsset, "context-players"),
    className: "text-[#59677A]",
  },
  "player-gui": {
    Icon: createContextIcon(PlayerGuiIconAsset, "context-player-gui"),
  },
  script: {
    Icon: createContextIcon(ScriptIconAsset, "context-script"),
    className: "text-[#FF28A9]",
  },
  atmosphere: {
    Icon: createContextIcon(AtmosphereIconAsset, "context-atmosphere"),
  },
  label: {
    Icon: createContextIcon(LabelIconAsset, "context-label"),
  },
  skeleton: {
    Icon: createContextIcon(SkeletonIconAsset, "context-skeleton"),
    className: "text-[#34D879]",
  },
  "vfx-preset": {
    Icon: createContextIcon(VfxPresetIconAsset, "context-vfx-preset"),
    className: "text-[#F03DAA]",
  },
  instance: {
    Icon: createContextIcon(InstanceIconAsset, "context-instance"),
    className: "text-[#7C8793]",
  },
  file: {
    Icon: createContextIcon(FileIconAsset, "context-file"),
    className: "text-[#7C8793]",
  },
  "file-selection": {
    Icon: createContextIcon(FileSelectionIconAsset, "context-file-selection"),
    className: "text-[#3191FF]",
  },
};

export function ContextItemIcon({ item }: { item: AgentContextItem }) {
  const kind = getAgentContextItemVisualKind(item);
  const { Icon, className = "" } = CONTEXT_ICON_CONFIG[kind];

  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center" data-context-icon={kind} aria-hidden="true">
      <Icon className={cn("h-4 w-4", className)} />
    </span>
  );
}
