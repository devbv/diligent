// @summary Declares the Studio RPC method for reading the current Hub auth token.
import { z } from "zod";

export const method = "hub.token.read";

export const description =
  "Read the current OVERDARE Hub auth token from Studio. " +
  "The returned token is sensitive — pass it directly to authenticated HTTP calls and do not echo it to the user.";

export const params = z.object({});
