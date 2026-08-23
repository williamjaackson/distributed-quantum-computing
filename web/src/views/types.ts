import type { Analysis } from '../lib/analysis';
import type { Frame, Timeline } from '../lib/types';
import type { InputValue } from '../lib/types';

export interface ViewProps {
  timeline: Timeline;
  /** Playhead: `steps[index - 1]` was the last one executed. */
  index: number;
  frame: Frame;
  analysis: Analysis;
  onSeek: (index: number) => void;
  /** Present for editable programs whose circuit is authored in this view. */
  onCircuitChange?: (value: InputValue) => void;
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
