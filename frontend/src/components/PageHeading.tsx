import type { ReactNode } from "react";

export function PageHeading({
  title,
  context,
  description,
  actions,
}: {
  title: string;
  context?: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-heading">
      {context && <p className="page-heading__context">{context}</p>}
      <div className="page-heading__line">
        <h1>{title}</h1>
        {actions}
      </div>
      {description && (
        <p className="page-heading__description">{description}</p>
      )}
    </header>
  );
}
