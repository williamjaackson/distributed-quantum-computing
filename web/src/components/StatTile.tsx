interface StatTileProps {
  label: string;
  value: string;
  sub?: string;
}

/** Label, value, optional sub-line. Proportional figures — not tabular, which
 *  makes a standalone number look loose at display sizes. */
export function StatTile({ label, value, sub }: StatTileProps) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

/** The one number a view leads with. Exactly one per view. */
export function Hero({ value, unit, detail }: { value: string; unit: string; detail: string }) {
  return (
    <div className="hero">
      <div>
        <span className="hero-value">{value}</span> <span className="hero-unit">{unit}</span>
      </div>
      <p className="hero-detail">{detail}</p>
    </div>
  );
}
