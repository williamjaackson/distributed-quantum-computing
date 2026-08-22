import type { Analysis } from '../lib/analysis';
import type { Execution } from '../lib/backend';
import type { Frame, Timeline } from '../lib/types';

export interface ViewProps {
  timeline: Timeline;
  /** Playhead: `steps[index - 1]` was the last one executed. */
  index: number;
  frame: Frame;
  analysis: Analysis;
  /** How the register is being held, for views that start their own run. */
  execution: Execution;
  onSeek: (index: number) => void;
}

export interface ViewDef {
  id: string;
  name: string;
  /** Sits beside the view title — what this projection is good for. */
  subtitle: string;
  Component: (props: ViewProps) => React.ReactNode;
}
