/**
 * Pass/fail marker. Icon plus text, never color alone — the status hues are
 * close enough to some series hues that hue cannot carry the distinction.
 */
export function Status({ pass }: { pass: boolean }) {
  return (
    <span className={`status ${pass ? 'status-pass' : 'status-fail'}`}>
      <span className="status-icon" aria-hidden="true">
        {pass ? '✓' : '✕'}
      </span>
      {pass ? 'Pass' : 'Fail'}
    </span>
  );
}
