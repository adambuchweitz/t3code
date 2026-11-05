import { useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../composerContextPresentation";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../ComposerPromptEditorTiptap";

function allowDefaultPaste() {}

/** The chat composer's rich text editor. A charter stays Markdown, so it survives being sent. */
export function TotCharterEditor(props: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly ariaLabel: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const [cursor, setCursor] = useState(props.value.length);
  return (
    <ComposerPromptEditor
      editorRef={editorRef}
      richTextEnabled
      value={props.value}
      cursor={cursor}
      contextRecords={EMPTY_COMPOSER_CONTEXT_RECORDS}
      skills={[]}
      disabled={props.disabled ?? false}
      placeholder={props.placeholder ?? ""}
      ariaLabel={props.ariaLabel}
      containerClassName={cn(
        "rounded-lg border border-input bg-background px-3 py-2 focus-within:border-ring dark:bg-input/32",
        props.className,
      )}
      className="max-h-96 min-h-24"
      onChange={(next, nextCursor) => {
        setCursor(nextCursor);
        props.onChange(next);
      }}
      onPaste={allowDefaultPaste}
    />
  );
}
