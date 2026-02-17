"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const SHOPPING_HIGHLIGHT_KEY = "planottoHighlightShoppingNav";
const NAV_ITEMS = [
  { path: "/recipes", label: "Рецепты" },
  { path: "/menu", label: "Меню" },
  { path: "/pantry", label: "Кладовка" },
  { path: "/shopping-list", label: "Покупки" },
  { path: "/auth", label: "Аккаунт" },
];

export default function Header() {
  const pathname = usePathname();
  const [highlightShopping, setHighlightShopping] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isCompactNav, setIsCompactNav] = useState(false);

  useEffect(() => {
    const updateHighlight = () => {
      if (typeof window === "undefined") return;
      setHighlightShopping(window.sessionStorage.getItem(SHOPPING_HIGHLIGHT_KEY) === "1");
    };

    updateHighlight();
    window.addEventListener("planotto:highlight-shopping", updateHighlight as EventListener);

    return () => {
      window.removeEventListener("planotto:highlight-shopping", updateHighlight as EventListener);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const viewportMedia = window.matchMedia("(max-width: 860px)");
    const coarseMedia = window.matchMedia("(pointer: coarse)");
    const syncCompactMode = () => {
      setIsCompactNav(viewportMedia.matches || coarseMedia.matches);
    };
    syncCompactMode();
    viewportMedia.addEventListener("change", syncCompactMode);
    coarseMedia.addEventListener("change", syncCompactMode);
    return () => {
      viewportMedia.removeEventListener("change", syncCompactMode);
      coarseMedia.removeEventListener("change", syncCompactMode);
    };
  }, []);

  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [pathname]);

  const linkClass = (path: string) =>
    pathname === path ? "nav__link nav__link--active" : "nav__link";

  const clearShoppingHighlight = () => {
    if (typeof window === "undefined") return;
    window.sessionStorage.removeItem(SHOPPING_HIGHLIGHT_KEY);
    setHighlightShopping(false);
  };

  const mascotSrc = "/mascot/pages/auth.png";

  return (
    <header className="header">
      <div className="container header__inner">
        <Link className="brand header-mascot" href="/">
          <Image
            src={mascotSrc}
            alt="Planotto mascot"
            width={40}
            height={40}
            className="header-mascot__image"
          />
          <div className="header-mascot__content">
            <div className="header-mascot__title">Planotto</div>
            <div className="header-mascot__slogan">
              Планируй, готовь и покупай
            </div>
          </div>
        </Link>

        {!isCompactNav ? (
          <nav className="nav">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.path}
                href={item.path}
                className={`${linkClass(item.path)}${
                  item.path === "/shopping-list" && highlightShopping && pathname !== "/shopping-list"
                    ? " nav__link--highlight"
                    : ""
                }`}
                onClick={() => item.path === "/shopping-list" && clearShoppingHighlight()}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        ) : null}
        <button
          className="header__menu-btn"
          onClick={() => setIsMobileMenuOpen((prev) => !prev)}
          type="button"
          aria-label="Открыть меню"
          style={{ display: isCompactNav ? "inline-flex" : "none" }}
        >
          <span className="header__menu-icon" />
        </button>
      </div>

      {isCompactNav && isMobileMenuOpen && (
        <div className="mobile-menu-overlay" onClick={() => setIsMobileMenuOpen(false)}>
          <div className="mobile-menu" onClick={(e) => e.stopPropagation()}>
            <nav>
              {NAV_ITEMS.map((item) => (
                <Link
                  key={item.path}
                  href={item.path}
                  className={linkClass(item.path)}
                  onClick={() => {
                    setIsMobileMenuOpen(false);
                    if (item.path === "/shopping-list") clearShoppingHighlight();
                  }}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </div>
      )}
    </header>
  );
}
