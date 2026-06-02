// @summary Declares the Studio RPC method for saving the current level files.
import { z } from "zod";

export const method = "level.save.file";

export const description =
  "Save the world currently being edited in the editor to file. Saving updates both .umap and .ovdrjm files.";

export const params = z.object({});
