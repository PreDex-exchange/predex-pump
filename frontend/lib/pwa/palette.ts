// Browser metadata and server-rendered PNGs cannot resolve CSS custom properties.
// Keep this small exception aligned with the corresponding values in tokens.css.
export const PWA_COLORS = {
  background: '#fff7ee',
  face: '#ffc24b',
  ink: '#2b2440',
  mouth: '#ff6b57',
  shadow: 'rgb(43 36 64 / 16%)',
} as const;
