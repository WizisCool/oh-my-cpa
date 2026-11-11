/**
 * The console's corner scale, in pixels. `index.css` declares the same steps as `--radius-*`
 * for stylesheets; this copy serves what cannot read a custom property: the component theme,
 * canvas painters and the self-contained conversation export. The roles and the nesting rule
 * are written beside the stylesheet's declaration.
 */
export const RADIUS = { xs: 2, sm: 4, md: 6, lg: 10, xl: 12 } as const;

export type RadiusStep = keyof typeof RADIUS;
