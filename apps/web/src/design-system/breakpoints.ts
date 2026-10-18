/** CSS media queries cannot use custom properties. architecture.test.ts keeps these values in sync with CSS. */
export const BREAKPOINTS = { phone: 600, catalog: 900 } as const;
export const CATALOG_DESKTOP_QUERY = `(min-width: ${BREAKPOINTS.catalog}px)`;
