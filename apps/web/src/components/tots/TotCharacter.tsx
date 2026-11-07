import {
  TOT_CHARACTER_VIEW_BOX,
  totCharacter,
  type TotPose,
} from "@t3tools/client-runtime/tots/character";

import { cn } from "~/lib/utils";

export function TotCharacter(props: {
  readonly character: string;
  readonly pose: TotPose;
  readonly size: number;
  readonly className?: string | undefined;
}) {
  return (
    <svg
      aria-hidden
      viewBox={TOT_CHARACTER_VIEW_BOX}
      width={props.size}
      height={props.size}
      className={cn("shrink-0 overflow-visible text-muted-foreground", props.className)}
      dangerouslySetInnerHTML={{ __html: totCharacter(props.character).draw(props.pose) }}
    />
  );
}
