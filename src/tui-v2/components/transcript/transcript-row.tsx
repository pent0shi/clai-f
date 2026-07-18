/** @jsxImportSource @opentui/react */
/**
 * Dispatches one normalized item to its renderer (V2-051..055).
 *
 * The only place that switches on `item.kind`; adding an item kind means
 * adding one case here plus its renderer, not touching a scattered UI switch
 * (ARCHITECTURE "commands are data plus handlers, not switch statements").
 */

import type { ReactNode } from "react";
import type { OutputSpool } from "../../../app/events/event-buffer.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { TranscriptStore } from "../../state/transcript-store.js";
import {
  isFileDiffExpanded,
  isItemExpanded,
  type TranscriptItem,
  type TranscriptState,
} from "../../state/transcript-types.js";
import type { Theme } from "../../rendering/theme.js";
import { shouldHideQuietMetaToolInChat } from "../../../app/adapters/quiet-meta-tools.js";
import { UserMessage } from "./user-message.js";
import { AssistantMessage } from "./assistant-message.js";
import { ThinkingBlock } from "./thinking-block.js";
import { ToolCard } from "./tool-card.js";
import { NoticeRow } from "./notice-row.js";
import { CompactedRow } from "./compacted-row.js";

/** Active ^R search highlight for a transcript row. */
export interface TranscriptSearchMark {
  /** This item contains at least one match for the current query. */
  readonly matched: boolean;
  /** This item is the currently selected n/N match. */
  readonly active: boolean;
}

export function TranscriptRow(props: {
  item: TranscriptItem;
  state: TranscriptState;
  theme: Theme;
  store: TranscriptStore;
  spool: OutputSpool;
  services: AppServices;
  onOpenUserPrompt: (prompt: string) => void;
  /** Chat-pane columns so markdown tables reflow beside the plan pane. */
  contentWidth?: number | undefined;
  /** Optional ^R search highlight for this item. */
  searchMark?: TranscriptSearchMark | undefined;
}): ReactNode {
  const {
    item,
    state,
    theme,
    store,
    spool,
    services,
    onOpenUserPrompt,
    contentWidth,
    searchMark,
  } = props;

  let body: ReactNode;
  switch (item.kind) {
    case "user":
      body = (
        <UserMessage
          item={item}
          theme={theme}
          onOpen={onOpenUserPrompt}
          contentWidth={contentWidth}
        />
      );
      break;
    case "assistant":
      body = (
        <AssistantMessage
          item={item}
          theme={theme}
          contentWidth={contentWidth}
        />
      );
      break;
    case "thinking":
      body = (
        <ThinkingBlock
          item={item}
          theme={theme}
          expanded={isItemExpanded(state, item)}
          onToggle={() => store.toggleItemOverride(item.id, state.expandThinkingGlobal)}
        />
      );
      break;
    case "tool": {
      // plan.create / task.update success is Tasks-pane only — hide from chat
      // so huge plan payloads never flood the transcript. Failures still show.
      if (shouldHideQuietMetaToolInChat(item.name, item.status)) {
        return null;
      }
      body = (
        <ToolCard
          item={item}
          theme={theme}
          spool={spool}
          services={services}
          expanded={isItemExpanded(state, item)}
          onToggle={() => store.toggleItemOverride(item.id, state.expandOutputGlobal)}
          fileDiffExpanded={isFileDiffExpanded(state, item.id)}
          onToggleFileDiff={() =>
            store.toggleFileDiffOverride(item.id, state.expandFileDiffsGlobal)
          }
          onCollapseAllFileDiffs={() => store.setFileDiffsGlobal(false)}
          onExpandAllFileDiffs={() => store.setFileDiffsGlobal(true)}
        />
      );
      break;
    }
    case "notice":
      body = <NoticeRow item={item} theme={theme} />;
      break;
    case "compacted":
      body = (
        <CompactedRow
          item={item}
          theme={theme}
          services={services}
          contentWidth={contentWidth}
          expanded={isItemExpanded(state, item)}
          onToggle={() => {
            // Ctrl+O / toggle: open pager (do not dump multi‑KB memory in chat).
            const summary = item.summary;
            const title =
              item.beforeTokens > 0 || item.afterTokens > 0
                ? `Compacted context · ~${item.beforeTokens.toLocaleString()} → ~${item.afterTokens.toLocaleString()} tokens`
                : "Compacted context";
            services.overlay.openPager(title, summary);
          }}
        />
      );
      break;
    default: {
      const unreachable: never = item;
      throw new Error(`unhandled transcript item: ${JSON.stringify(unreachable)}`);
    }
  }

  // Search highlight wrapper — active match gets a strong wash; other hits a soft one.
  if (!searchMark?.matched) return body;
  return (
    <box
      border
      borderStyle="rounded"
      style={{
        width: "100%",
        flexDirection: "column",
        backgroundColor: searchMark.active ? theme.selection : theme.rowA,
        borderColor: searchMark.active ? theme.activity : theme.cyan,
        marginBottom: 0,
      }}
    >
      {body}
    </box>
  );
}
