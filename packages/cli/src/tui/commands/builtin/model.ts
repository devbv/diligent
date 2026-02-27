import { resolveModel, KNOWN_MODELS } from "@diligent/core";
import { ListPicker, type ListPickerItem } from "../../components/list-picker";
import { t } from "../../theme";
import type { Command } from "../types";

export const modelCommand: Command = {
  name: "model",
  description: "Switch model or show picker",
  supportsArgs: true,
  handler: async (args, ctx) => {
    if (args) {
      try {
        const model = resolveModel(args);
        ctx.config.model = model;
        ctx.displayLines([`  Model switched to ${t.bold}${model.id}${t.reset}`]);
      } catch {
        ctx.displayError(`Unknown model: ${args}`);
      }
      return;
    }

    // Show picker with known models
    const currentModelId = ctx.config.model.id;
    const items: ListPickerItem[] = KNOWN_MODELS.map(m => ({
      label: m.id,
      description: m.aliases?.length ? `(${m.aliases.join(", ")})` : undefined,
      value: m.id,
    }));

    const selectedIdx = items.findIndex(i => i.value === currentModelId);

    return new Promise<void>(resolve => {
      const picker = new ListPicker(
        { title: "Model", items, selectedIndex: Math.max(0, selectedIdx) },
        (value) => {
          handle.hide();
          ctx.requestRender();
          if (value) {
            const model = resolveModel(value);
            ctx.config.model = model;
            ctx.displayLines([`  Model switched to ${t.bold}${model.id}${t.reset}`]);
          }
          resolve();
        },
      );
      const handle = ctx.showOverlay(picker, { anchor: "center" });
      ctx.requestRender();
    });
  },
};
