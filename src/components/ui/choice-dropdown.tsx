"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { UiIcon } from "@/components/ui/ui-icon";


export function ChoiceDropdown({
  disabled,
  labelId,
  onChange,
  options,
  value,
  id,
}: {
  disabled: boolean;
  labelId: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  id: string;
  value: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const optionIdPrefix = useId();
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  useEffect(() => {
    if (!open) return;
    const option = rootRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    const list = option?.parentElement;
    if (!option || !list) return;
    const bottom = option.offsetTop + option.offsetHeight;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [open, activeIndex]);

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

  const selected = options[selectedIndex];

  function openDropdown() {
    setActiveIndex(selectedIndex);
    setOpen(true);
  }

  function choose(index: number) {
    if (disabled || options[index] === undefined) return;
    onChange(options[index].value);
    setActiveIndex(index);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveActive(offset: number) {
    if (options.length === 0) return;
    const next = (activeIndex + offset + options.length) % options.length;
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
        setActiveIndex(options.length - 1);
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
        id={id}
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
        disabled={disabled || options.length === 0}
        onClick={() => (open ? setOpen(false) : openDropdown())}
        onKeyDown={handleKeyDown}
      >
        <span>{selected?.label ?? "暂无可选项"}</span>
        <UiIcon name="chevron-down" className="scenario-dropdown__chevron" />
      </button>

      {open && !disabled ? (
        <ul
          id={listboxId}
          className="scenario-dropdown__list"
          role="listbox"
          aria-labelledby={labelId}
        >
          {options.map((option, index) => {
            const selectedOption = index === selectedIndex;
            return (
              <li
                id={`${optionIdPrefix}-${index}`}
                key={option.value}
                className="scenario-dropdown__option"
                role="option"
                aria-selected={selectedOption}
                data-active={index === activeIndex}
                onClick={() => choose(index)}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span>{option.label}</span>
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
