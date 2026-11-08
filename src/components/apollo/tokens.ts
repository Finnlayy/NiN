/**
 * Apollo / Obsidian Galaxy design tokens.
 * Extracted from the UI/UX specification (image prompts + implementation blueprint).
 * Colors: deep void black / matte obsidian (#090A0F), galaxy violet (#8B5CF6),
 * cyber emerald (#10B981), amber gold (#F59E0B), crimson (#EF4444).
 * Motion: cubic-bezier(0.16, 1, 0.3, 1), 180ms–240ms UI transitions.
 */

export const APOLLO_TOKENS = {
  // Canvas
  bg: '#090a0f',
  bgDeep: '#050609',
  // Surfaces
  panel: 'rgba(18, 20, 28, 0.75)',
  panelHover: 'rgba(18, 20, 28, 0.88)',
  // Borders
  border: 'rgba(255, 255, 255, 0.07)',
  borderFocus: 'rgba(139, 92, 246, 0.5)',
  borderHover: 'rgba(139, 92, 246, 0.25)',
  // Accents
  violet: '#8b5cf6',
  violetGlass: 'rgba(139, 92, 246, 0.30)',
  violetNeon: 'rgba(139, 92, 246, 0.9)',
  cyan: '#22d3ee',
  emerald: '#10b981',
  emeraldGlass: 'rgba(16, 185, 129, 0.25)',
  amber: '#f59e0b',
  amberGlass: 'rgba(245, 158, 11, 0.16)',
  crimson: '#ef4444',
  crimsonGlass: 'rgba(239, 68, 68, 0.18)',
  // Text
  text: '#f8fafc',
  textMuted: '#94a3b8',
  textDim: '#64748b',
  // Typography
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
  // Motion
  easeUi: 'cubic-bezier(0.16, 1, 0.3, 1)',
  durationUi: '200ms',
} as const;

export type NodeType = 'Sweep' | 'Detect' | 'Track';

export const NODE_STYLES: Record<NodeType, { color: string; label: string }> = {
  Sweep: { color: APOLLO_TOKENS.violet, label: 'SWEEP' },
  Detect: { color: APOLLO_TOKENS.cyan, label: 'DETECT' },
  Track: { color: APOLLO_TOKENS.emerald, label: 'TRACK' },
};
