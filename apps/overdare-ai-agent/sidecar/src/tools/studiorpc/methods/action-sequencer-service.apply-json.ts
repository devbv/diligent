import { z } from "zod";

export const method = "action_sequencer_service.apply_json";

export const description = "Apply a sequencer JSON file to an existing Action Sequencer instance in the level.";

export const params = z.object({
  instanceGuid: z.string().describe("GUID of the target Action Sequencer instance"),
  jsonFilePath: z.string().describe("Absolute file path to the sequencer JSON file"),
});
