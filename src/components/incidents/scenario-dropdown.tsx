"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { UiIcon } from "@/components/ui/ui-icon";
import type { ScenarioResponse } from "@/lib/agent-runtime/view-models";

export function ScenarioDropdown({
  disabled,
  labelId,
  onChange,
  scenarios,
  value,
}: {
  disabled: boolean;
  labelId: string;
  onChange: (scenarioId: string) => void;
  scenarios: ScenarioResponse[];
  value: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const optionIdPrefix = useId();
  const selectedIndex = Math.max(
    0,
    scenarios.findIndex((scenario) => scenario.scenarioId === value),
  );
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  useEffect(() => {
    if (!open) {
      return;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  const selected = scenarios[selectedIndex];

  function openDropdown() {
    setActiveIndex(selectedIndex);
    setOpen(true);
  }

  function choose(index: number) {
    onChange(scenarios[index].scenarioId);
    setActiveIndex(index);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveActive(offset: number) {
    const next = (activeIndex + offset + scenarios.length) % scenarios.length;
    setActiveIndex(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (open) {
          moveActive(1);
        } else {
          openDropdown();
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (open) {
          moveActive(-1);
        } else {
          openDropdown();
        }
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        setOpen(true);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(scenarios.length - 1);
        setOpen(true);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (open) {
          choose(activeIndex);
        } else {
          openDropdown();
        }
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  }

  return (
    <div ref={rootRef} className="scenario-dropdown">
      <button
        ref={triggerRef}
        id="scenario"
        className="scenario-dropdown__trigger"
        type="button"
        role="combobox"
        aria-activedescendant={
          open ? `${optionIdPrefix}-${activeIndex}` : undefined
        }
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-labelledby={labelId}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openDropdown())}
        onKeyDown={handleKeyDown}
      >
        <span>{selected.displayName}</span>
        <UiIcon name="chevron-down" className="scenario-dropdown__chevron" />
      </button>

      {open ? (
        <ul
          id={listboxId}
          className="scenario-dropdown__list"
          role="listbox"
          aria-labelledby={labelId}
        >
          {scenarios.map((scenario, index) => {
            const selectedOption = index === selectedIndex;
            return (
              <li
                id={`${optionIdPrefix}-${index}`}
                key={scenario.scenarioId}
                className="scenario-dropdown__option"
                role="option"
                aria-selected={selectedOption}
                data-active={index === activeIndex}
                onClick={() => choose(index)}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span>{scenario.displayName}</span>
                <span className="scenario-dropdown__check" aria-hidden="true">
                  {selectedOption ? <UiIcon name="check" /> : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
