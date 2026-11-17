import {
  GIT_BUTLER_END_HOLD_LABEL,
  type GitButlerPublishConfirmation,
} from "@t3tools/client-runtime/state/vcs";

import * as Dialog from "../components/ui/Dialog";

export function confirmGitButlerPublish(
  confirmation: GitButlerPublishConfirmation,
): Promise<"publish" | "end_holds" | "cancel"> {
  return new Promise((resolve) => {
    Dialog.alert(
      confirmation.title,
      confirmation.description,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve("cancel") },
        ...(confirmation.resolutions.length > 0
          ? [{ text: GIT_BUTLER_END_HOLD_LABEL, onPress: () => resolve("end_holds") }]
          : []),
        {
          text: confirmation.confirmLabel,
          style: "destructive",
          onPress: () => resolve("publish"),
        },
      ],
      { onDismiss: () => resolve("cancel") },
    );
  });
}

export function confirmGitButlerHoldReview(review: {
  readonly title: string;
  readonly description: string;
  readonly resolutions: readonly string[];
}): Promise<boolean> {
  return new Promise((resolve) => {
    if (review.resolutions.length === 0) {
      Dialog.alert(
        review.title,
        review.description,
        [{ text: "OK", onPress: () => resolve(false) }],
        {
          onDismiss: () => resolve(false),
        },
      );
      return;
    }
    Dialog.confirm({
      title: review.title,
      message: review.description,
      confirmText: GIT_BUTLER_END_HOLD_LABEL,
      destructive: true,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

export function alertGitButlerHoldFailure(title: string, error: unknown): void {
  Dialog.alert(title, error instanceof Error ? error.message : String(error));
}
