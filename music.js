export const BASE_MIDI_RANGE = { min: 36, max: 96 };

export const chromas = [
  { label: "C", index: 0 },
  { label: "C♯", index: 1 },
  { label: "D", index: 2 },
  { label: "E♭", index: 3 },
  { label: "E", index: 4 },
  { label: "F", index: 5 },
  { label: "F♯", index: 6 },
  { label: "G", index: 7 },
  { label: "A♭", index: 8 },
  { label: "A", index: 9 },
  { label: "B♭", index: 10 },
  { label: "B", index: 11 },
];

export const chromaLookup = {
  C: 0,
  "C♯": 1,
  Db: 1,
  D: 2,
  "D♯": 3,
  Eb: 3,
  "E♭": 3,
  E: 4,
  F: 5,
  "F♯": 6,
  Gb: 6,
  "G♭": 6,
  G: 7,
  "G♯": 8,
  Ab: 8,
  "A♭": 8,
  A: 9,
  "A♯": 10,
  Bb: 10,
  "B♭": 10,
  B: 11,
};

const baseChromaSets = [
  {
    name: "Chromatic",
    exerciseType: "Chromatic",
    notes: chromas.map((chroma) => chroma.label),
  },
];

export const chromaSets = baseChromaSets.map((set) => ({
  ...set,
  label: set.name === "Chromatic" ? "Chromatic" : `${set.name}: ${set.notes.join(", ")}`,
  chromas: set.notes.map((note) => ({ label: note, index: chromaLookup[note] })),
}));

export const instruments = [
  "Bassoon",
  "Cellos",
  "Clarinet",
  "Flute",
  "Harp",
  "Horn",
  "Oboe",
  "Piano",
  "Trumpet",
  "Violins",
];

export const instrumentRanges = {
  Bassoon: { min: 36, max: 79 },
  Cellos: { min: 37, max: 80 },
  Clarinet: { min: 50, max: 92 },
  Flute: { min: 60, max: 94 },
  Harp: { min: 36, max: 96 },
  Horn: { min: 36, max: 79 },
  Oboe: { min: 58, max: 93 },
  Piano: { min: 36, max: 96 },
  Trumpet: { min: 52, max: 91 },
  Violins: { min: 56, max: 96 },
};
