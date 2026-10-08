import { useId, useRef } from 'react';

export function Tabs({
  tabs,
  selected,
  onSelect,
  panelId = 'run-tab-panel',
}: {
  tabs: Array<{ key: string; label: string }>;
  selected: string;
  onSelect: (key: string) => void;
  panelId?: string;
}) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={container}
      className="tabs"
      role="tablist"
      onKeyDown={(event) => {
        const currentIndex = tabs.findIndex((tab) => tab.key === selected);
        const nextIndex =
          event.key === 'ArrowRight'
            ? (currentIndex + 1) % tabs.length
            : event.key === 'ArrowLeft'
              ? (currentIndex - 1 + tabs.length) % tabs.length
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : undefined;
        if (nextIndex === undefined) return;
        event.preventDefault();
        const nextTab = tabs[nextIndex];
        if (nextTab) {
          onSelect(nextTab.key);
          container.current?.querySelectorAll<HTMLButtonElement>('button')[nextIndex]?.focus();
        }
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.key}
          // Tabs also sit inside forms (MarkdownEditor); switching must not submit them.
          type="button"
          id={`${id}-${tab.key}`}
          className={`tab ${tab.key === selected ? 'active' : ''}`}
          role="tab"
          tabIndex={tab.key === selected ? 0 : -1}
          aria-selected={tab.key === selected}
          aria-controls={panelId}
          onClick={() => onSelect(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
