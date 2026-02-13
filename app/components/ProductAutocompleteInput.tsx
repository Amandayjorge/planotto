"use client";

import { useMemo, useState, type CSSProperties } from "react";

interface ProductAutocompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  placeholder?: string;
  minChars?: number;
  maxItems?: number;
  inputClassName?: string;
  inputStyle?: CSSProperties;
}

export default function ProductAutocompleteInput({
  value,
  onChange,
  suggestions,
  placeholder,
  minChars = 2,
  maxItems = 8,
  inputClassName = "input",
  inputStyle,
}: ProductAutocompleteInputProps) {
  const [isFocused, setIsFocused] = useState(false);

  const query = value.trim().toLowerCase();
  const visibleSuggestions = useMemo(() => {
    if (query.length < minChars) return [];

    return suggestions
      .filter((item) => item.toLowerCase().includes(query))
      .filter((item) => item.toLowerCase() !== query)
      .slice(0, maxItems);
  }, [query, suggestions, minChars, maxItems]);

  const showDropdown = isFocused && visibleSuggestions.length > 0;

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setIsFocused(true)}
        onBlur={() => {
          setTimeout(() => setIsFocused(false), 120);
        }}
        placeholder={placeholder}
        className={inputClassName}
        style={inputStyle}
      />

      {showDropdown && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 20,
            border: "1px solid var(--border-default)",
            borderRadius: "10px",
            background: "var(--background-primary)",
            boxShadow: "var(--card-shadow)",
            overflow: "hidden",
          }}
        >
          {visibleSuggestions.map((item) => (
            <button
              key={item}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
              }}
              onClick={() => {
                onChange(item);
                setIsFocused(false);
              }}
              style={{
                width: "100%",
                textAlign: "left",
                border: "none",
                background: "transparent",
                color: "var(--text-primary)",
                padding: "8px 10px",
                cursor: "pointer",
                fontSize: "14px",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--background-secondary)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              {item}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
