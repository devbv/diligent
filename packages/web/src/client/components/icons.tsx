// @summary SVG icon React components imported through SVGR

import type { ComponentType, SVGProps } from "react";
import AgentLogoIcon from "../icons/agent-logo.svg?react";
import AlignJustifyIcon from "../icons/align-justify.svg?react";
import BookOpenIcon from "../icons/book-open.svg?react";
import BotIcon from "../icons/bot.svg?react";
import CheckIcon from "../icons/check.svg?react";
import ChevronDownIcon from "../icons/chevron-down.svg?react";
import ChevronRightIcon from "../icons/chevron-right.svg?react";
import ClipboardListIcon from "../icons/clipboard-list.svg?react";
import ClockIcon from "../icons/clock.svg?react";
import DatabaseIcon from "../icons/database.svg?react";
import ExternalLinkIcon from "../icons/external-link.svg?react";
import FileTextIcon from "../icons/file-text.svg?react";
import FlagIcon from "../icons/flag.svg?react";
import GlobeIcon from "../icons/globe.svg?react";
import LandmarkIcon from "../icons/landmark.svg?react";
import ListIcon from "../icons/list.svg?react";
import ListChecksIcon from "../icons/list-checks.svg?react";
import MenuIcon from "../icons/menu.svg?react";
import PencilIcon from "../icons/pencil.svg?react";
import PlusIcon from "../icons/plus.svg?react";
import SearchIcon from "../icons/search.svg?react";
import SendIcon from "../icons/send.svg?react";
import SettingsIcon from "../icons/settings.svg?react";
import SlidersHorizontalIcon from "../icons/sliders-horizontal.svg?react";
import SparklesIcon from "../icons/sparkles.svg?react";
import SquareTerminalIcon from "../icons/square-terminal.svg?react";
import TextCursorInputIcon from "../icons/text-cursor-input.svg?react";
import Trash2Icon from "../icons/trash-2.svg?react";
import XIcon from "../icons/x.svg?react";

export type IconProps = SVGProps<SVGSVGElement>;
export type IconComponent = ComponentType<IconProps>;

function createIcon(component: unknown, name: string): IconComponent {
  if (typeof component === "function") return component as IconComponent;

  return function IconFallback(props: IconProps) {
    return <svg viewBox="0 0 24 24" fill="none" focusable="false" aria-hidden="true" {...props} data-icon={name} />;
  };
}

export const AgentLogo = createIcon(AgentLogoIcon, "agent-logo");
export const AlignJustify = createIcon(AlignJustifyIcon, "align-justify");
export const BookOpen = createIcon(BookOpenIcon, "book-open");
export const Bot = createIcon(BotIcon, "bot");
export const Check = createIcon(CheckIcon, "check");
export const ChevronDown = createIcon(ChevronDownIcon, "chevron-down");
export const ChevronRight = createIcon(ChevronRightIcon, "chevron-right");
export const ClipboardList = createIcon(ClipboardListIcon, "clipboard-list");
export const Clock = createIcon(ClockIcon, "clock");
export const Database = createIcon(DatabaseIcon, "database");
export const ExternalLink = createIcon(ExternalLinkIcon, "external-link");
export const FileText = createIcon(FileTextIcon, "file-text");
export const Flag = createIcon(FlagIcon, "flag");
export const Globe = createIcon(GlobeIcon, "globe");
export const Landmark = createIcon(LandmarkIcon, "landmark");
export const List = createIcon(ListIcon, "list");
export const ListChecks = createIcon(ListChecksIcon, "list-checks");
export const Menu = createIcon(MenuIcon, "menu");
export const Pencil = createIcon(PencilIcon, "pencil");
export const Plus = createIcon(PlusIcon, "plus");
export const Search = createIcon(SearchIcon, "search");
export const Send = createIcon(SendIcon, "send");
export const Settings = createIcon(SettingsIcon, "settings");
export const SlidersHorizontal = createIcon(SlidersHorizontalIcon, "sliders-horizontal");
export const Sparkles = createIcon(SparklesIcon, "sparkles");
export const SquarePen = createIcon(PencilIcon, "pencil");
export const SquareTerminal = createIcon(SquareTerminalIcon, "square-terminal");
export const TextCursorInput = createIcon(TextCursorInputIcon, "text-cursor-input");
export const Trash2 = createIcon(Trash2Icon, "trash-2");
export const X = createIcon(XIcon, "x");
