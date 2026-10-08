/**
 * Layout breakpoints shared with the CSS variables --bp-sm / --bp-md / --bp-lg. CSS media queries
 * cannot read custom properties, so stylesheets repeat these numbers and scripts read them here.
 */
export const BREAKPOINT_SM_PX = 640;
export const BREAKPOINT_MD_PX = 900;
export const BREAKPOINT_LG_PX = 1200;

/** Matches widths up to --bp-md, where wide tables fold their secondary columns into the row. */
export const NARROW_LAYOUT_QUERY = `(max-width: ${BREAKPOINT_MD_PX}px)`;
