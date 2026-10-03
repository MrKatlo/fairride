/**
 * A deliberately small design system. Everything visual pulls from here so a
 * restyle never turns into a hunt through screens.
 */
export const colors = {
  background: '#0B0F14',
  surface: '#141A22',
  surfaceRaised: '#1C2530',
  border: '#26313D',
  primary: '#16C784',
  primaryDark: '#0E8A5C',
  danger: '#F6465D',
  warning: '#F0B90B',
  text: '#F5F7FA',
  textMuted: '#93A1B0',
  textInverse: '#04121B',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 20,
  pill: 999,
} as const;

export const font = {
  small: 12,
  body: 15,
  title: 18,
  display: 26,
} as const;
