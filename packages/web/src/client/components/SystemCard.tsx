// @summary Outer wrapper card for system-level inline cards (approval, question)

import { cardPaddingLooseClasses, surfaceCardClasses } from "./ui-styles";

interface SystemCardProps {
  children: React.ReactNode;
}

export function SystemCard({ children }: SystemCardProps) {
  return (
    <div className="flex justify-start">
      <div className={`w-full max-w-assistant ${cardPaddingLooseClasses} ${surfaceCardClasses}`}>{children}</div>
    </div>
  );
}
