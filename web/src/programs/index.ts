/**
 * The program registry.
 *
 * Each program is its own file — a program is a self-contained thing with its
 * own inputs, its own readouts and its own explanation, and the point of the
 * split is that adding one means adding a file and a line here, with nothing
 * else in the app needing to know about it.
 *
 * Ordered simplest first, which is also a reasonable order to demo them in.
 */
import type { Program } from '../lib/types';
import { coin } from './coin';
import { interference } from './interference';
import { bell } from './bell';
import { ghz } from './ghz';
import { teleport } from './teleport';
import { deutschJozsa } from './deutschJozsa';
import { grover } from './grover';
import { qft } from './qft';
import { adder } from './adder';

export const PROGRAMS: Program[] = [
  coin,
  interference,
  bell,
  ghz,
  teleport,
  deutschJozsa,
  grover,
  qft,
  adder,
];

export function programById(id: string): Program {
  return PROGRAMS.find((p) => p.id === id) ?? PROGRAMS[0];
}
