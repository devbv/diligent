// @summary Renders consecutive collab events in order without nested group toggles

import type { ThreadReadResponse } from "@diligent/protocol";
import type { RenderItem } from "../lib/thread-store";
import { CollabEventBlock } from "./CollabEventBlock";

type CollabItem = Extract<RenderItem, { kind: "collab" }>;

interface CollabGroupProps {
  items: CollabItem[];
  loadChildThread?: (childThreadId: string) => Promise<ThreadReadResponse>;
}

export function CollabGroup({ items, loadChildThread }: CollabGroupProps) {
  return (
    <div className="pb-1">
      <div className="space-y-0">
        {items.map((item) => (
          <CollabEventBlock key={item.id} item={item} loadChildThread={loadChildThread} />
        ))}
      </div>
    </div>
  );
}
