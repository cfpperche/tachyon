import { render } from "preact";
import { useState } from "preact/hooks";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../shared/ui/vendor/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../shared/ui/vendor/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../shared/ui/vendor/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../shared/ui/vendor/popover";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../shared/ui/vendor/dialog";
import {
  KitSelect,
  KitFieldRow,
  KitLabeledInput,
  KitDropdown,
  KitDropdownTrigger,
  KitDropdownContent,
  KitDropdownItem,
  KitPopover,
  KitPopoverTrigger,
  KitPopoverContent,
} from "../shared/ui/kit";
import { PREFLIGHT_FIXTURE_HTML } from "./preflightFixture";

// spec 342 T3 — THE COMPAT GATE: all five vendored components, each with a stable `data-testid` on its
// trigger/content so test/browser/uiGate.test.ts can target it precisely. Nothing here is a "kit" wrapper
// (T4) — this page exists ONLY to observe whether Radix's focus/dismissal machinery (FocusScope,
// DismissableLayer, Portal, roving focus, composed refs) behaves correctly under preact/compat. Per-component
// pass/fail is recorded in docs/specs/342-vendored-ui-components/notes.md, not here.
function Root() {
  const [selectValue, setSelectValue] = useState<string | undefined>(undefined);
  const [kitSelectValue, setKitSelectValue] = useState<string | undefined>(undefined);
  const [kitInputValue, setKitInputValue] = useState("");

  return (
    <div style={{ padding: "2rem", display: "flex", flexDirection: "column", gap: "2rem" }}>
      <section>
        <h2>Tooltip</h2>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger data-testid="tooltip-trigger">Hover or focus me</TooltipTrigger>
            <TooltipContent data-testid="tooltip-content">Gate tooltip content</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </section>

      <section>
        <h2>DropdownMenu</h2>
        <DropdownMenu>
          <DropdownMenuTrigger data-testid="dropdown-trigger">Open menu</DropdownMenuTrigger>
          <DropdownMenuContent data-testid="dropdown-content">
            <DropdownMenuItem data-testid="dropdown-item-alpha">Alpha</DropdownMenuItem>
            <DropdownMenuItem data-testid="dropdown-item-bravo">Bravo</DropdownMenuItem>
            <DropdownMenuItem data-testid="dropdown-item-charlie">Charlie</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </section>

      <section>
        <h2>Select</h2>
        <Select value={selectValue} onValueChange={setSelectValue}>
          <SelectTrigger data-testid="select-trigger">
            <SelectValue placeholder="Pick one" />
          </SelectTrigger>
          <SelectContent data-testid="select-content">
            <SelectItem value="alpha" data-testid="select-item-alpha">Alpha</SelectItem>
            <SelectItem value="bravo" data-testid="select-item-bravo">Bravo</SelectItem>
            <SelectItem value="charlie" data-testid="select-item-charlie">Charlie</SelectItem>
          </SelectContent>
        </Select>
      </section>

      <section>
        <h2>Popover</h2>
        <Popover>
          <PopoverTrigger data-testid="popover-trigger">Open popover</PopoverTrigger>
          <PopoverContent data-testid="popover-content">
            <input data-testid="popover-input" placeholder="focusable field" />
          </PopoverContent>
        </Popover>
      </section>

      <section>
        <h2>Dialog</h2>
        <Dialog>
          <DialogTrigger data-testid="dialog-trigger">Open dialog</DialogTrigger>
          <DialogContent data-testid="dialog-content">
            <DialogHeader>
              <DialogTitle>Gate dialog</DialogTitle>
              <DialogDescription>Modal focus-trap check</DialogDescription>
            </DialogHeader>
            <input data-testid="dialog-input" placeholder="focusable field" />
            <DialogClose data-testid="dialog-close-footer">Close</DialogClose>
          </DialogContent>
        </Dialog>
      </section>

      <section data-testid="kit-section">
        <h2>Kit (T4)</h2>
        <div data-testid="kit-field-row">
          <KitFieldRow>
            <KitLabeledInput
              data-testid="kit-labeled-input"
              label="Kit input"
              description="a description"
              value={kitInputValue}
              onInput={setKitInputValue}
            />
            <div>
              <label id="kit-select-label">Kit select</label>
              <KitSelect
                aria-label="Kit select"
                data-testid="kit-select-trigger"
                value={kitSelectValue}
                onValueChange={setKitSelectValue}
                placeholder="Pick one"
                options={[
                  { value: "alpha", label: "Alpha" },
                  { value: "bravo", label: "Bravo" },
                ]}
              />
            </div>
          </KitFieldRow>
        </div>
        <KitDropdown>
          <KitDropdownTrigger data-testid="kit-dropdown-trigger">Kit menu</KitDropdownTrigger>
          <KitDropdownContent data-testid="kit-dropdown-content">
            <KitDropdownItem data-testid="kit-dropdown-item">Item</KitDropdownItem>
          </KitDropdownContent>
        </KitDropdown>
        <KitPopover>
          <KitPopoverTrigger data-testid="kit-popover-trigger">Kit popover</KitPopoverTrigger>
          <KitPopoverContent data-testid="kit-popover-content">
            <input data-testid="kit-popover-input" placeholder="focusable field" />
          </KitPopoverContent>
        </KitPopover>
      </section>

      <section
        data-testid="preflight-fixture"
        dangerouslySetInnerHTML={{ __html: PREFLIGHT_FIXTURE_HTML }}
      />
    </div>
  );
}

render(<Root />, document.getElementById("root")!);
