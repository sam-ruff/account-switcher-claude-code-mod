// Clawd, the Claude Code mascot as its welcome banner draws him, with a hat row
// on top. Every row is nine cells wide. A hat can also swap his face row, which
// is how sunglasses sit over his eyes.

export interface Segment {
  text: string
  colour: string
  background?: string
}

export interface Hat {
  id: string
  name: string
  /** The row above Clawd's head. */
  top: Segment[]
  /** Replaces Clawd's face row when set. */
  face?: Segment[]
}

export const CLAWD_COLOUR = 'rgb(215,119,87)'
export const CLAWD_ROWS = [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  ']

const BLANK: Segment[] = [{ text: '         ', colour: 'text' }]
const solid = (text: string, colour: string): Segment[] => [{ text, colour }]
const SHADES = 'rgb(30,30,36)'

export const HATS: Hat[] = [
  { id: 'none', name: 'No hat', top: BLANK },
  { id: 'top', name: 'Top hat', top: solid('  ▗███▖  ', 'rgb(90,90,100)') },
  {
    // A cone in pink, blue and yellow stripes.
    id: 'party',
    name: 'Party hat',
    top: [
      { text: '  ', colour: 'text' },
      { text: '▗', colour: 'rgb(232,121,249)' },
      { text: '▟', colour: 'rgb(96,165,250)' },
      { text: '█', colour: 'rgb(250,204,21)' },
      { text: '▙', colour: 'rgb(232,121,249)' },
      { text: '▖', colour: 'rgb(96,165,250)' },
      { text: '  ', colour: 'text' },
    ],
  },
  { id: 'crown', name: 'Crown', top: solid('  ▙▟▙▟▙  ', 'rgb(250,204,21)') },
  { id: 'beanie', name: 'Beanie', top: solid('  ▗▟█▙▖  ', 'rgb(96,165,250)') },
  { id: 'cap', name: 'Cap', top: solid('  ▗███▄▄ ', 'rgb(239,68,68)') },
  { id: 'wizard', name: 'Wizard hat', top: solid('   ▗█▖   ', 'rgb(139,92,246)') },
  { id: 'chef', name: 'Chef hat', top: solid('  ▟███▙  ', 'rgb(245,245,245)') },
  { id: 'cowboy', name: 'Cowboy hat', top: solid(' ▄▄▟█▙▄▄ ', 'rgb(180,83,9)') },
  { id: 'halo', name: 'Halo', top: solid('  ▁▁▁▁▁  ', 'rgb(253,224,71)') },
  { id: 'bow', name: 'Bow', top: solid('   ▚▄▞   ', 'rgb(244,114,182)') },
  { id: 'headphones', name: 'Headphones', top: solid(' ▗▛▀▀▀▜▖ ', 'rgb(34,197,94)') },
  {
    id: 'sunglasses',
    name: 'Sunglasses',
    top: BLANK,
    // Dark lenses over the lower half of his face row, where his eyes are, with
    // his face showing above them and a bridge between.
    face: [
      { text: ' ▐', colour: CLAWD_COLOUR },
      { text: '▄▄▄▄▄', colour: SHADES, background: CLAWD_COLOUR },
      { text: '▌ ', colour: CLAWD_COLOUR },
    ],
  },
]

export function hatById(id: string | undefined): Hat {
  return HATS.find(h => h.id === id) ?? HATS[0]
}

/** The hat `step` places along from `id`, wrapping at either end. */
export function cycleHat(id: string | undefined, step: number): Hat {
  const index = HATS.indexOf(hatById(id))
  return HATS[(((index + step) % HATS.length) + HATS.length) % HATS.length]
}

/** Clawd's four rows wearing `hat`, each as coloured segments. */
export function clawdRows(hat: Hat): Segment[][] {
  return [hat.top, hat.face ?? solid(CLAWD_ROWS[0], CLAWD_COLOUR), solid(CLAWD_ROWS[1], CLAWD_COLOUR), solid(CLAWD_ROWS[2], CLAWD_COLOUR)]
}
