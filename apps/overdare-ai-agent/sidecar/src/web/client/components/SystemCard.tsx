// @summary Outer wrapper card for system-level inline cards (approval, question)

interface SystemCardProps {
  children: React.ReactNode;
}

export function SystemCard({ children }: SystemCardProps) {
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-assistant rounded-lg border border-border/100 bg-black px-3 py-3">{children}</div>
    </div>
  );
}
