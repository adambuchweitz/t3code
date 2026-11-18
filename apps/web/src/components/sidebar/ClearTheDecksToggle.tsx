import { T, useGT, useMessages } from "gt-react";
import { BrushCleaningIcon, ChevronDownIcon } from "lucide-react";

import { CLEAR_THE_DECKS_DURATIONS, useClearTheDecks } from "../../hooks/useClearTheDecks";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ClearTheDecksToggle() {
  const gt = useGT();
  const m = useMessages();
  const { enabled, setEnabled, preset, setPreset } = useClearTheDecks();
  const selected = CLEAR_THE_DECKS_DURATIONS[preset];
  return (
    <div className="relative z-10 flex shrink-0 items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="sm"
              variant={enabled ? "secondary" : "ghost-muted"}
              aria-label={gt("Clear the decks")}
              aria-pressed={enabled}
              onClick={() => setEnabled((value) => !value)}
            />
          }
        >
          <BrushCleaningIcon />
          <span className="sr-only @[20rem]/sidebar-header:not-sr-only">
            <T>Clear decks</T>
          </span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          <div>{enabled ? gt("Clear the decks is on") : gt("Clear the decks")}</div>
          <div>{m(selected.sendDescription)}</div>
        </TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="sm"
              variant={enabled ? "secondary" : "ghost-muted"}
              aria-label={gt("Clear the decks snooze duration")}
            />
          }
        >
          {m(selected.shortLabel)}
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="end" side="bottom">
          <MenuGroup>
            <MenuGroupLabel>
              <T>Snooze after sending</T>
            </MenuGroupLabel>
            <MenuRadioGroup value={preset} onValueChange={setPreset}>
              <MenuRadioItem value="hour">
                <T>1 hour</T>
              </MenuRadioItem>
              <MenuRadioItem value="three-hours">
                <T>3 hours</T>
              </MenuRadioItem>
              <MenuRadioItem value="tomorrow">
                <T>Tomorrow morning</T>
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </MenuPopup>
      </Menu>
    </div>
  );
}
