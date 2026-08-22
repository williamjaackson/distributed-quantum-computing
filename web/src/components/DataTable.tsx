import { useState, type ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
}

/**
 * The table-view twin every chart carries.
 *
 * Tooltips enhance but never gate a value: anything readable only on hover is
 * also readable here, which is also the relief for the light-mode series color
 * that sits below 3:1 against the surface.
 */
export function DataTable<T>({ rows, columns }: { rows: T[]; columns: Column<T>[] }) {
  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.key}>{c.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TableDisclosure({ label = 'table', children }: { label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="table-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? `Hide ${label}` : `Show ${label}`}
      </button>
      {open && children}
    </>
  );
}
