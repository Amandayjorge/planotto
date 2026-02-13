"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const SHOPPING_HIGHLIGHT_KEY = "planottoHighlightShoppingNav";

export default function Header() {
  const pathname = usePathname();
  const [highlightShopping, setHighlightShopping] = useState(false);

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

        <nav className="nav">
          <Link href="/recipes" className={linkClass("/recipes")}>
            Рецепты
          </Link>

          <Link href="/menu" className={linkClass("/menu")}>
            Меню
          </Link>

          <Link href="/pantry" className={linkClass("/pantry")}>
            Кладовка
          </Link>

          <Link
            href="/shopping-list"
            className={`${linkClass("/shopping-list")}${
              highlightShopping && pathname !== "/shopping-list" ? " nav__link--highlight" : ""
            }`}
            onClick={clearShoppingHighlight}
          >
            Покупки
          </Link>

          <Link href="/auth" className={linkClass("/auth")}>
            Аккаунт
          </Link>
        </nav>
      </div>
    </header>
  );
}
