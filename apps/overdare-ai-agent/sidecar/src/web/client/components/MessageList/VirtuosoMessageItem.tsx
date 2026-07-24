// @summary Stable Virtuoso item wrapper used as the measured message row boundary

import type { Components, ContextProp, ItemProps } from "react-virtuoso";
import { MESSAGE_LIST_VERTICAL_PADDING_PX, MESSAGE_ROW_GAP_PX } from "./constants";
import { getRowSizeCacheKey } from "./row-size-cache";
import type { VirtualMessageRow, VirtuosoMessageListContext } from "./types";

function VirtuosoMessageItem({
  children,
  context,
  item,
  style,
  ...props
}: ItemProps<VirtualMessageRow> & ContextProp<VirtuosoMessageListContext>) {
  const index = props["data-index"];
  return (
    <div
      {...props}
      data-message-list-row={item.key}
      data-message-list-size-key={getRowSizeCacheKey(context.transcriptKey, item)}
      className="flow-root px-7 [overflow-anchor:none]"
      style={{
        ...style,
        paddingBottom: index < context.rowCount - 1 ? MESSAGE_ROW_GAP_PX : MESSAGE_LIST_VERTICAL_PADDING_PX,
        paddingTop: index === 0 ? MESSAGE_LIST_VERTICAL_PADDING_PX : 0,
      }}
    >
      {children}
    </div>
  );
}

export const VIRTUOSO_COMPONENTS = {
  Item: VirtuosoMessageItem,
} satisfies Components<VirtualMessageRow, VirtuosoMessageListContext>;
