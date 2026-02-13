"use client";

import React from "react";

interface LinkifiedTextProps {
  text: string;
  className?: string;
}

const URL_REGEX = /((https?:\/\/|www\.)[^\s<]+)/gi;

const splitTrailingPunctuation = (value: string) => {
  const match = value.match(/^(.*?)([.,!?;:)]*)$/);
  if (!match) return { url: value, tail: "" };
  return { url: match[1], tail: match[2] };
};

const toHref = (value: string) => {
  if (value.toLowerCase().startsWith("http://") || value.toLowerCase().startsWith("https://")) {
    return value;
  }
  return `https://${value}`;
};

export default function LinkifiedText({ text, className }: LinkifiedTextProps) {
  const parts = text.split(URL_REGEX);

  return (
    <span className={className}>
      {parts.map((part, index) => {
        if (!part) return null;

        const isUrl = /^(https?:\/\/|www\.)/i.test(part);
        if (!isUrl) {
          return <React.Fragment key={`text-${index}`}>{part}</React.Fragment>;
        }

        const { url, tail } = splitTrailingPunctuation(part);
        if (!url) {
          return <React.Fragment key={`url-empty-${index}`}>{part}</React.Fragment>;
        }

        return (
          <React.Fragment key={`url-${index}`}>
            <a
              href={toHref(url)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--accent-secondary)", textDecoration: "underline" }}
            >
              {url}
            </a>
            {tail}
          </React.Fragment>
        );
      })}
    </span>
  );
}
