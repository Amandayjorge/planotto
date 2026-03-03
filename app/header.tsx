"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useI18n } from "./components/I18nProvider";
import {
  getPrimaryRouteByProfileGoal,
  readProfileGoalFromStorage,
} from "./lib/profileGoal";
import { getSupportMailto } from "./lib/support";

const SHOPPING_HIGHLIGHT_KEY = "planottoHighlightShoppingNav";
interface NavItem {
  path: string;
  labelKey: string;
  mobileLabelKey?: string;
  showDesktop?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { path: "/", labelKey: "header.nav.home" },
  { path: "/recipes", labelKey: "header.nav.recipes" },
  { path: "/menu", labelKey: "header.nav.menu" },
  { path: "/pantry", labelKey: "header.nav.pantry" },
  { path: "/shopping-list", labelKey: "header.nav.shopping" },
  { path: "/how-it-works", labelKey: "header.nav.howIcon", mobileLabelKey: "header.nav.how" },
];

export default function Header() {
  const pathname = usePathname();
  const { t } = useI18n();
  const [highlightShopping, setHighlightShopping] = useState(false);
  const [mobileMenuOpenedForPath, setMobileMenuOpenedForPath] = useState<string | null>(null);
  const [brandHref, setBrandHref] = useState("/menu");
  const isMobileMenuOpen = mobileMenuOpenedForPath === pathname;

  const closeMobileMenu = () => {
    setMobileMenuOpenedForPath(null);
  };

  const toggleMobileMenu = () => {
    setMobileMenuOpenedForPath((prev) => (prev === pathname ? null : pathname));
  };

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
    const refreshBrandHref = () => {
      setBrandHref(getPrimaryRouteByProfileGoal(readProfileGoalFromStorage()));
    };

    refreshBrandHref();
    window.addEventListener("storage", refreshBrandHref);
    window.addEventListener("focus", refreshBrandHref);
    return () => {
      window.removeEventListener("storage", refreshBrandHref);
      window.removeEventListener("focus", refreshBrandHref);
    };
  }, []);

  useEffect(() => {
    if (!isMobileMenuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileMenuOpenedForPath(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMobileMenuOpen]);

  const linkClass = (path: string) =>
    pathname === path ? "nav__link nav__link--active" : "nav__link";

  const mobileLinkClass = (path: string) =>
    pathname === path ? "mobile-menu__link mobile-menu__link--active" : "mobile-menu__link";
  const accountLinkClass =
    pathname === "/auth" ? "header__account-link header__account-link--active" : "header__account-link";

  const clearShoppingHighlight = () => {
    if (typeof window === "undefined") return;
    window.sessionStorage.removeItem(SHOPPING_HIGHLIGHT_KEY);
    setHighlightShopping(false);
  };

  const mascotSrc = "/mascot/pages/auth.png";
  const contactMailto = getSupportMailto("Planotto feedback");
  const bugMailto = getSupportMailto("Planotto bug report");

  return (
    <header className="header">
      <div className="container header__inner">
        <Link className="brand header-mascot" href={brandHref}>
          <Image
            src={mascotSrc}
            alt={t("header.aria.logoAlt")}
            width={40}
            height={40}
            className="header-mascot__image"
          />
          <div className="header-mascot__content">
            <div className="header-mascot__title">Planotto</div>
            <div className="header-mascot__slogan">{t("header.slogan")}</div>
          </div>
        </Link>

        <nav className="nav">
          {NAV_ITEMS.filter((item) => item.showDesktop !== false).map((item) => (
            <Link
              key={item.path}
              href={item.path}
              className={`${linkClass(item.path)}${
                item.path === "/shopping-list" && highlightShopping && pathname !== "/shopping-list"
                  ? " nav__link--highlight"
                  : ""
              }`}
              onClick={() => item.path === "/shopping-list" && clearShoppingHighlight()}
              title={t(item.mobileLabelKey || item.labelKey)}
              aria-label={t(item.mobileLabelKey || item.labelKey)}
            >
              {t(item.labelKey)}
            </Link>
          ))}
        </nav>
        <div className="header__actions">
          <Link
            href="/auth"
            className={accountLinkClass}
            title={t("header.nav.account")}
            aria-label={t("header.nav.account")}
          >
            <span className="header__account-icon" aria-hidden="true">👤</span>
          </Link>
          <button
            className="header__menu-btn"
            onClick={toggleMobileMenu}
            type="button"
            aria-label={t("header.aria.openMenu")}
          >
            <span className="header__menu-icon" />
          </button>
        </div>
      </div>

      {isMobileMenuOpen && (
        <div className="mobile-menu-overlay" onClick={closeMobileMenu}>
          <div
            className="mobile-menu"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={t("header.aria.navigation")}
          >
            <div className="mobile-menu__header">
              <span className="mobile-menu__title">{t("header.aria.navigation")}</span>
              <button
                type="button"
                className="mobile-menu__close"
                onClick={closeMobileMenu}
                aria-label={t("header.aria.closeMenu")}
                title={t("header.aria.closeMenu")}
              >
                ×
              </button>
            </div>
            <nav className="mobile-menu__nav">
              {NAV_ITEMS.map((item) => (
                <Link
                  key={item.path}
                  href={item.path}
                  className={mobileLinkClass(item.path)}
                  onClick={() => {
                    closeMobileMenu();
                    if (item.path === "/shopping-list") clearShoppingHighlight();
                  }}
                >
                  {t(item.mobileLabelKey || item.labelKey)}
                </Link>
              ))}
            </nav>
            <div className="mobile-menu__section">
              <span className="mobile-menu__section-title">{t("header.support.title")}</span>
              <Link className="mobile-menu__support-link" href="/how-it-works" onClick={closeMobileMenu}>
                {t("header.support.help")}
              </Link>
              <a className="mobile-menu__support-link" href={contactMailto} onClick={closeMobileMenu}>
                {t("header.support.contact")}
              </a>
              <a className="mobile-menu__support-link" href={bugMailto} onClick={closeMobileMenu}>
                {t("header.support.reportBug")}
              </a>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
