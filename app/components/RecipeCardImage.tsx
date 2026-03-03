"use client";

import type { CSSProperties } from "react";

const PLACEHOLDER_PAIRS: [string, string][] = [
  ["#fef9c3", "#fcd34d"],
  ["#ecfeff", "#7dd3fc"],
  ["#f3e8ff", "#c084fc"],
  ["#fde68a", "#f97316"],
  ["#dbf4ff", "#38bdf8"],
  ["#ecfccb", "#4ade80"],
  ["#fee2e2", "#fb7185"],
  ["#ffe4e6", "#fb7185"],
  ["#ede9fe", "#a855f7"],
];

const hashString = (value: string): number => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
};

const getPlaceholderColors = (seed: string): [string, string] => {
  if (!seed) return PLACEHOLDER_PAIRS[0];
  const index = hashString(seed) % PLACEHOLDER_PAIRS.length;
  return PLACEHOLDER_PAIRS[index];
};

const getInitials = (label: string): string => {
  const parts = label
    .split(/\s+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  if (parts.length === 0) return label.trim().slice(0, 1).toUpperCase() || "R";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
};

export interface RecipeCardImageProps {
  imageUrl?: string | null;
  label?: string;
  width?: string | number;
  height?: string | number;
  radius?: string | number;
  className?: string;
  style?: CSSProperties;
}

const BASE_SIZE = 84;

export default function RecipeCardImage({
  imageUrl,
  label,
  width,
  height,
  radius = "10px",
  className,
  style,
}: RecipeCardImageProps) {
  const safeLabel = (label || "Рецепт").trim();
  const trimmedImage = imageUrl?.trim();
  const resolvedWidth = width ?? BASE_SIZE;
  const resolvedHeight = height ?? BASE_SIZE;
  const placeholderColors = getPlaceholderColors(safeLabel);
  const placeholderStyle: CSSProperties = {
    width: resolvedWidth,
    height: resolvedHeight,
    borderRadius: radius,
    display: "grid",
    placeItems: "center",
    background: `linear-gradient(135deg, ${placeholderColors[0]}, ${placeholderColors[1]})`,
    color: "#0f172a",
    fontSize: "20px",
    fontWeight: 700,
    textTransform: "uppercase",
    textAlign: "center",
  };

  if (trimmedImage) {
    const imageStyle: CSSProperties = {
      width: resolvedWidth,
      height: resolvedHeight,
      borderRadius: radius,
      objectFit: "cover",
      ...style,
    };
    return (
      <img
        src={trimmedImage}
        alt={safeLabel || "Рецепт"}
        className={className}
        style={imageStyle}
        loading="lazy"
      />
    );
  }

  return (
    <div
      className={className}
      style={placeholderStyle}
      role="img"
      aria-label={`${safeLabel} (нет фото)`}
    >
      {getInitials(safeLabel)}
    </div>
  );
}
