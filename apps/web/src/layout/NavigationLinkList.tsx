import { useId } from 'react';
import { NavLink } from 'react-router-dom';
import { text } from '../i18n/catalog';
import type { NavigationGroup } from './navigationLinks';

/** The main navigation's links under their group labels, laid out by the sidebar or the drawer. */
export function NavigationLinkList({ groups }: { groups: NavigationGroup[] }) {
  const idPrefix = useId();
  return (
    <nav aria-label={text.navigation}>
      {groups.map((group, index) => {
        const labelId = `${idPrefix}-group-${index}`;
        return (
          <div key={group.label} className="navigation-group" role="group" aria-labelledby={labelId}>
            <span id={labelId} className="navigation-group-label">
              {group.label}
            </span>
            {group.links.map((link) => (
              <NavLink key={link.to} to={link.to}>
                {link.label}
              </NavLink>
            ))}
          </div>
        );
      })}
    </nav>
  );
}
