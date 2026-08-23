import { evenSplit } from './shots';

export interface ShotCapacity {
  machines: number;
  smallestShare: number;
  largestShare: number;
}

export function shotCapacity(shots: number, helpers: number): ShotCapacity {
  const machines = Math.max(1, Math.floor(helpers) + 1);
  const shares = evenSplit(Math.max(0, Math.floor(shots)), machines);
  return {
    machines,
    smallestShare: Math.min(...shares),
    largestShare: Math.max(...shares),
  };
}
