import { useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { handleProjectFocusShortcutKeyDown } from "./Sidebar.logic";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "./ui/combobox";

const projects = [
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta" },
];

function ProjectPicker({ onToggle }: { onToggle: (project: string) => void }) {
  const highlightedRef = useRef<string | null>(null);
  const [open, setOpen] = useState(true);
  const [scope, setScope] = useState<string | null>(null);
  return (
    <>
      <p role="status">{`${open ? "open" : "closed"} ${scope ?? "all"}`}</p>
      <Combobox
        items={projects}
        itemToStringLabel={(item) => item.label}
        isItemEqualToValue={(a, b) => a.value === b.value}
        open={open}
        onOpenChange={setOpen}
        onItemHighlighted={(item) => {
          highlightedRef.current = item?.value ?? null;
        }}
        value={projects.find((project) => project.value === scope) ?? null}
        onValueChange={(item) => setScope(item?.value ?? null)}
      >
        <ComboboxTrigger>Filter</ComboboxTrigger>
        <ComboboxPopup>
          <ComboboxSearchInput
            aria-label="Search projects"
            onKeyDown={(event) => {
              handleProjectFocusShortcutKeyDown(event, {
                project: highlightedRef.current,
                toggle: onToggle,
              });
            }}
          />
          <ComboboxList>
            {(item: (typeof projects)[number]) => (
              <ComboboxItem key={item.value} value={item}>
                {item.label}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </>
  );
}

it("toggles focus on Shift+Enter once per press without selecting or closing", async () => {
  const onToggle = vi.fn();
  await using screen = await render(<ProjectPicker onToggle={onToggle} />);
  const status = screen.getByRole("status");
  const search = page.getByRole("combobox", { name: "Search projects" });

  await userEvent.click(search);
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  expect(onToggle).toHaveBeenCalledExactlyOnceWith("alpha");
  await expect.element(status).toHaveTextContent("open all");

  // A held key repeats keydown; only the first press toggles.
  await act(() => {
    search.element().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        shiftKey: true,
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(onToggle).toHaveBeenCalledOnce();
  await expect.element(status).toHaveTextContent("open all");

  // Plain Enter still selects, so the shortcut is what kept the scope.
  await userEvent.keyboard("{Enter}");
  expect(onToggle).toHaveBeenCalledOnce();
  await expect.element(status).toHaveTextContent("closed alpha");
});
