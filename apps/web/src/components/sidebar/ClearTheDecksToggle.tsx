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
              aria-label="Clear the decks"
              aria-pressed={enabled}
              onClick={() => setEnabled((value) => !value)}
            />
          }
        >
          <BrushCleaningIcon />
          <span className="sr-only @[20rem]/sidebar-header:not-sr-only">Clear decks</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          <div>Clear the decks{enabled ? " is on" : ""}</div>
          <div>Send, {selected.sendLabel.toLowerCase()}, and open the next attention thread.</div>
        </TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="sm"
              variant={enabled ? "secondary" : "ghost-muted"}
              aria-label="Clear the decks snooze duration"
            />
          }
        >
          {selected.shortLabel}
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="end" side="bottom">
          <MenuGroup>
            <MenuGroupLabel>Snooze after sending</MenuGroupLabel>
            <MenuRadioGroup value={preset} onValueChange={setPreset}>
              <MenuRadioItem value="hour">1 hour</MenuRadioItem>
              <MenuRadioItem value="three-hours">3 hours</MenuRadioItem>
              <MenuRadioItem value="tomorrow">Tomorrow morning</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </MenuPopup>
      </Menu>
    </div>
  );
}
