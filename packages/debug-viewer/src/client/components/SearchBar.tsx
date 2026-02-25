import { useCallback, useEffect, useRef } from "react";

interface SearchBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  matchCount: number;
  currentIndex: number;
  onNext: () => void;
  onPrev: () => void;
}

export function SearchBar({ query, onQueryChange, matchCount, currentIndex, onNext, onPrev }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onQueryChange(value);
      }, 300);
    },
    [onQueryChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.shiftKey ? onPrev() : onNext();
      }
    },
    [onNext, onPrev],
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div className="search-bar">
      <input
        ref={inputRef}
        type="text"
        className="search-input"
        placeholder="Search..."
        defaultValue={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
      {query && (
        <span className="search-count">{matchCount > 0 ? `${currentIndex + 1}/${matchCount}` : "0 results"}</span>
      )}
    </div>
  );
}
