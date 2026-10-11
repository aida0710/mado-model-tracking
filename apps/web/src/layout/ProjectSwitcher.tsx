import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import type { Project } from '@mmt/contracts';
import { usePopover } from '../hooks/usePopover';
import { useAnchoredPopover } from '../hooks/useAnchoredPopover';
import { VisibilityLabel } from '../components/VisibilityLabel';
import { filterProjects, shouldOfferProjectFilter } from '../lib/projectFilter';
import { isListNavigationKey, moveActiveIndex } from '../lib/listNavigation';
import { isComposingKey } from '../lib/imeComposition';
import { text } from '../i18n/catalog';
import { projectHomePath } from './navigationLinks';

// Wide enough for a Project name, the lock and the role on one row even when the sidebar is narrow.
const SWITCHER_MIN_WIDTH = 280;
// About ten rows; longer lists scroll inside the dropdown.
const SWITCHER_MAX_HEIGHT = 420;

type SwitcherEntry = { kind: 'project'; project: Project } | { kind: 'create' };

/**
 * Opens a Project from a dropdown listing every Project with its visibility and the user's role,
 * the open one marked. With many Projects a field narrows the list; the last entry creates a
 * Project for those who may (`onCreateProject`). ↑↓, Home and End move, Enter opens, Esc closes;
 * opening highlights the open Project. The dropdown stays inside the window in the sidebar and in
 * the narrow screen's project bar alike.
 */
export function ProjectSwitcher({
  projects,
  project,
  onCreateProject,
}: {
  projects: Project[];
  project?: Project;
  onCreateProject?: () => void;
}) {
  const navigate = useNavigate();
  const idPrefix = useId();
  const labelId = `${idPrefix}-label`;
  const valueId = `${idPrefix}-value`;
  const listboxId = `${idPrefix}-listbox`;
  const optionId = (index: number) => `${idPrefix}-option-${index}`;
  const dropdown = usePopover();
  const { container, isOpen, close } = dropdown;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const popoverStyle = useAnchoredPopover({
    isOpen,
    anchorRef: triggerRef,
    popoverRef,
    minWidth: SWITCHER_MIN_WIDTH,
    maxHeight: SWITCHER_MAX_HEIGHT,
  });
  const offersFilter = shouldOfferProjectFilter(projects.length);
  const shownProjects = filterProjects(projects, query);
  const entries: SwitcherEntry[] = [
    ...shownProjects.map((item): SwitcherEntry => ({ kind: 'project', project: item })),
    ...(onCreateProject ? [{ kind: 'create' } as const] : []),
  ];
  const activeOptionId = entries[activeIndex] ? optionId(activeIndex) : undefined;
  const isCurrentEntry = (entry: SwitcherEntry) =>
    entry.kind === 'project' && entry.project.id === project?.id;

  useEffect(() => {
    if (!isOpen) return;
    (offersFilter ? filterRef.current : listboxRef.current)?.focus();
  }, [isOpen, offersFilter]);
  useEffect(() => {
    if (isOpen && activeOptionId)
      document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' });
  }, [isOpen, activeOptionId]);

  const open = () => {
    setQuery('');
    setActiveIndex(Math.max(0, projects.findIndex((item) => item.id === project?.id)));
    dropdown.open();
  };
  const closeToTrigger = () => {
    close();
    triggerRef.current?.focus();
  };
  const choose = (entry: SwitcherEntry) => {
    closeToTrigger();
    if (entry.kind === 'create') onCreateProject?.();
    else if (entry.project.id !== project?.id) navigate(projectHomePath(entry.project.id));
  };
  const handleListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // While Japanese input converts the filter text, Enter and ↑↓ belong to the input method.
    if (isComposingKey(event)) return;
    if (isListNavigationKey(event.key)) {
      event.preventDefault();
      setActiveIndex(
        moveActiveIndex({ current: activeIndex, key: event.key, count: entries.length }),
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const entry = entries[activeIndex];
      if (entry) choose(entry);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeToTrigger();
    }
  };
  // Tab or a click elsewhere moves the focus out, which closes the dropdown.
  const closeWhenFocusLeaves = (event: FocusEvent<HTMLDivElement>) => {
    if (isOpen && !event.currentTarget.contains(event.relatedTarget as Node | null)) close();
  };
  // Keeps the focus where the keys are handled when a row, the padding around the filter, the "no
  // results" line or the border is pressed; otherwise the focus would drop to the page and close
  // the dropdown. Only the filter itself takes the press, to place the caret. A row's click still
  // chooses it.
  const keepFocusOnPress = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== filterRef.current) event.preventDefault();
  };

  return (
    <div className="project-switcher" ref={container} onBlur={closeWhenFocusLeaves}>
      <span id={labelId} className="project-switcher-label">
        {text.project}
      </span>
      <button
        ref={triggerRef}
        type="button"
        className="project-switcher-trigger"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        aria-labelledby={`${labelId} ${valueId}`}
        onClick={() => (isOpen ? close() : open())}
        onKeyDown={(event) => {
          if (!isOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            open();
          }
        }}
      >
        <span id={valueId} className="project-switcher-value">
          {project ? project.name : text.projectSwitcherPlaceholder}
        </span>
        {project && <VisibilityLabel visibility={project.visibility} iconOnly />}
        <ChevronsUpDown size={14} aria-hidden="true" className="project-switcher-chevron" />
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          popover="manual"
          className="project-switcher-popover"
          style={popoverStyle}
          onMouseDown={keepFocusOnPress}
        >
          {offersFilter && (
            <input
              ref={filterRef}
              type="search"
              className="project-switcher-filter"
              role="combobox"
              aria-label={text.projectSwitcherFilter}
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listboxId}
              aria-activedescendant={activeOptionId}
              placeholder={text.projectSwitcherFilter}
              autoComplete="off"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleListKeyDown}
            />
          )}
          {shownProjects.length === 0 && <p className="project-switcher-empty">{text.noResults}</p>}
          <ul
            ref={listboxRef}
            id={listboxId}
            role="listbox"
            aria-label={text.project}
            className="project-switcher-list"
            tabIndex={offersFilter ? -1 : 0}
            aria-activedescendant={offersFilter ? undefined : activeOptionId}
            onKeyDown={handleListKeyDown}
          >
            {entries.map((entry, index) => (
              <li
                key={entry.kind === 'project' ? entry.project.id : 'create'}
                id={optionId(index)}
                role="option"
                aria-selected={isCurrentEntry(entry)}
                className={[
                  'project-switcher-option',
                  entry.kind === 'create' && 'project-switcher-create',
                  index === activeIndex && 'active',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => choose(entry)}
              >
                <SwitcherEntryContent entry={entry} isCurrent={isCurrentEntry(entry)} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One row: a Project with its visibility and the user's role (checked when open), or creation. */
function SwitcherEntryContent({ entry, isCurrent }: { entry: SwitcherEntry; isCurrent: boolean }) {
  if (entry.kind === 'create')
    return (
      <>
        <Plus size={14} aria-hidden="true" />
        <span className="project-switcher-name">{text.newProject}</span>
      </>
    );
  return (
    <>
      <Check
        size={14}
        aria-hidden="true"
        className="project-switcher-check"
        data-current={isCurrent}
      />
      <span className="project-switcher-name">{entry.project.name}</span>
      <VisibilityLabel visibility={entry.project.visibility} iconOnly />
      <span className="project-switcher-role">{text[entry.project.role]}</span>
    </>
  );
}
