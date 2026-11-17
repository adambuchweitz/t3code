import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  HouseIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { memo } from "react";

import { useThreadShell } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { cn } from "~/lib/utils";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
  type SidebarThreadStatus,
} from "../Sidebar.logic";

// Mirrors the labels and colors thread rows use for the same statuses.
const HOME_STATUS: Record<
  Exclude<SidebarThreadStatus, "ready"> | "done",
  { label: string; Icon: LucideIcon; className: string }
> = {
  preparing: { label: "Setting up", Icon: CircleDotDashedIcon, className: "text-info" },
  working: { label: "Working", Icon: CircleDotDashedIcon, className: "text-info" },
  waiting: { label: "Waiting", Icon: CircleDashedIcon, className: "text-muted-foreground" },
  approval: { label: "Approval", Icon: ShieldQuestionIcon, className: "text-warning-foreground" },
  input: {
    label: "Input",
    Icon: MessageCircleQuestionIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  request: { label: "Request", Icon: UserRoundIcon, className: "text-guest-foreground" },
  limited: { label: "Limited", Icon: CircleAlertIcon, className: "text-warning" },
  failed: { label: "Failed", Icon: CircleAlertIcon, className: "text-error" },
  done: { label: "Done", Icon: CircleCheckIcon, className: "text-success" },
};

/**
 * The fixed row for the current Home thread, above every other row. Home has
 * no project, settle, or pin affordances, so it only shows its status.
 */
export const SidebarHomeRow = memo(function SidebarHomeRow(props: {
  threadRef: ScopedThreadRef;
  isActive: boolean;
  onActivate: (threadRef: ScopedThreadRef) => void;
}) {
  const { isActive, onActivate, threadRef } = props;
  const thread = useThreadShell(threadRef);
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const threadStatus = thread === null ? null : resolveSidebarThreadStatus(thread);
  const statusKind =
    threadStatus === "ready"
      ? thread !== null &&
        hasUnseenCompletion({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
        })
        ? "done"
        : null
      : threadStatus;
  const status = statusKind === null ? null : HOME_STATUS[statusKind];
  const activate = () => onActivate(threadRef);
  return (
    <li className="list-none">
      <div
        role="button"
        tabIndex={0}
        aria-label={status ? `Home, ${status.label}` : "Home"}
        aria-current={isActive ? "page" : undefined}
        data-testid="sidebar-home-row"
        className={cn(
          "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm font-medium outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          activate();
        }}
      >
        <HouseIcon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Home</span>
        {status ? (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 text-xs font-medium",
              status.className,
            )}
          >
            <status.Icon aria-hidden className="size-4 shrink-0" />
            <span role="status">{status.label}</span>
          </span>
        ) : null}
      </div>
    </li>
  );
});
