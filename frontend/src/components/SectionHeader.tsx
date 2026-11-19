export function SectionHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <header className="section-heading">
      <h2>{title}</h2>
      {description && <p>{description}</p>}
    </header>
  );
}
