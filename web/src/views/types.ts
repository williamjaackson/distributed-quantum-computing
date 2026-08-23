import type { Analysis } from '../lib/analysis';
import type { Frame, Timeline } from '../lib/types';

export interface ViewProps {
  timeline: Timeline;
  /** Playhead: `steps[index - 1]` was the last one executed. */
  index: number;
  frame: Frame;
  analysis: Analysis;
  onSeek: (index: number) => void;
}

export interface ViewDef {
  id: string;
  name: string;
  /** Sits beside the view title — what this projection is good for. */
  subtitle: string;
  /**
   * How to read it, behind the ⓘ.
   *
   * This used to be a paragraph under every chart. It is worth having and it is
   * not worth permanent screen space: you read it once.
   */
  about: string;
  Component: (props: ViewProps) => React.ReactNode;
}
