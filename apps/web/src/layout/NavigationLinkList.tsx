import { useId } from 'react';
import { NavLink } from 'react-router-dom';
import { text } from '../i18n/catalog';
import type { NavigationGroup } from './navigationLinks';
import { NAVIGATION_ICONS } from './navigationIcons';

/**
 * The main navigation's links with their icons under the group labels, laid out by the sidebar,
 * the rail or the drawer. The rail hides the names on screen, so it shows them as tooltips.
 */
export function NavigationLinkList({
  groups,
  showsTitles = false,
}: {
  groups: NavigationGroup[];
  showsTitles?: boolean;
}) {
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
            {group.links.map((link) => {
              const Icon = NAVIGATION_ICONS[link.screen];
              return (
                <NavLink
                  key={link.to}
                  to={link.to}
                  className="navigation-link"
                  title={showsTitles ? link.label : undefined}
                >
                  <Icon aria-hidden="true" />
                  <span className="navigation-label">{link.label}</span>
                </NavLink>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
