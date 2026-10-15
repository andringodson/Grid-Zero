export interface Livery {
  primary: number;
  accent: number;
  /** Sidewall band colour for the tyre compound. */
  compound?: number;
  /** Race number painted on the nose and engine cover. */
  number?: number;
}

export interface Team {
  id: string;
  name: string;
  livery: Livery;
  drivers: [string, string];
  /** Each driver's race number. */
  numbers: [number, number];
}

/** Ten fictional constructors. Names and colours are original, so nothing here needs a licence. */
export const TEAMS: readonly Team[] = [
  { id: 'halcyon', name: 'Halcyon Racing', livery: { primary: 0x0e7c86, accent: 0x111417 }, drivers: ['Marek Voss', 'Ines Calder'], numbers: [8, 21] },
  { id: 'vantor', name: 'Vantor Grand Prix', livery: { primary: 0xc4161c, accent: 0xf2f2f2 }, drivers: ['Luca Ferrand', 'Theo Brandt'], numbers: [12, 27] },
  { id: 'kessler', name: 'Kessler Motorsport', livery: { primary: 0xb8bec6, accent: 0x0b0c0e }, drivers: ['Jonas Kerr', 'Arjun Mehta'], numbers: [6, 19] },
  { id: 'aurora', name: 'Aurora Works', livery: { primary: 0xf47a20, accent: 0x1c3f94 }, drivers: ['Oscar Lind', 'Priya Nair'], numbers: [9, 25] },
  { id: 'northline', name: 'Northline Racing', livery: { primary: 0x14254d, accent: 0xf6c90e }, drivers: ['Sam Okafor', 'Elena Ruiz'], numbers: [15, 30] },
  { id: 'verdant', name: 'Verdant Racing Team', livery: { primary: 0x0f5c3a, accent: 0xd9e021 }, drivers: ['Felix Haas', 'Kenji Mori'], numbers: [17, 26] },
  { id: 'solstice', name: 'Solstice F', livery: { primary: 0x5b2a86, accent: 0xf2f2f2 }, drivers: ['Dario Conti', 'Noah Fischer'], numbers: [24, 37] },
  { id: 'solace', name: 'Solace Engineering', livery: { primary: 0xf2f2f2, accent: 0x1a75ff }, drivers: ['Ravi Iyer', 'Lena Novak'], numbers: [29, 42] },
  { id: 'ironvale', name: 'Ironvale', livery: { primary: 0x2b2d31, accent: 0xff3b30 }, drivers: ['Mateo Silva', 'Hugo Lambert'], numbers: [38, 47] },
  { id: 'cobalt', name: 'Cobalt Dynamics', livery: { primary: 0x1f6fd1, accent: 0xff5ab4 }, drivers: ['Aiden Walsh', 'Yuki Sato'], numbers: [52, 64] },
];
