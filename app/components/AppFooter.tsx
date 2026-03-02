"use client";

import Link from "next/link";
import { useI18n } from "./I18nProvider";
import { getSupportMailto } from "../lib/support";

export default function AppFooter() {
  const { t } = useI18n();

  return (
    <footer className="footer">
      <div className="container footer__inner">
        <span>Planotto</span>
        <div className="footer__links">
          <Link className="footer__link" href="/how-it-works">
            {t("appFooter.help")}
          </Link>
          <a className="footer__link" href={getSupportMailto("Planotto feedback")}>
            {t("appFooter.contact")}
          </a>
        </div>
      </div>
    </footer>
  );
}
