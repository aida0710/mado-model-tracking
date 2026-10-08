import { NavLink } from 'react-router-dom';
import { text } from '../i18n/catalog';
import type { NavigationLink } from './navigationLinks';

/** The main navigation's links, laid out by the top bar or the drawer that holds them. */
export function NavigationLinkList({ links }: { links: NavigationLink[] }) {
  return (
    <nav aria-label={text.navigation}>
      {links.map((link) => (
        <NavLink key={link.to} to={link.to}>
          {link.label}
        </NavLink>
      ))}
    </nav>
  );
}
