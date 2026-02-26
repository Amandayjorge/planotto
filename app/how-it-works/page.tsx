"use client";

import { useI18n } from "../components/I18nProvider";

export default function HowItWorksPage() {
  const { t } = useI18n();

  return (
    <section className="card" style={{ display: "grid", gap: "12px", maxWidth: "840px", margin: "0 auto" }}>
      <h1 className="h1" style={{ marginBottom: "0" }}>{t("howPage.title")}</h1>
      <p className="muted">{t("howPage.subtitle")}</p>

      <article className="card" style={{ padding: "12px" }}>
        <h2 style={{ margin: "0 0 6px", fontSize: "22px" }}>1) {t("howPage.periodProducts.title")}</h2>
        <p className="muted">{t("howPage.periodProducts.description")}</p>
      </article>

      <article className="card" style={{ padding: "12px" }}>
        <h2 style={{ margin: "0 0 6px", fontSize: "22px" }}>2) {t("howPage.writeOff.title")}</h2>
        <p className="muted">{t("howPage.writeOff.description")}</p>
      </article>

      <article className="card" style={{ padding: "12px" }}>
        <h2 style={{ margin: "0 0 6px", fontSize: "22px" }}>3) {t("howPage.menuVsShopping.title")}</h2>
        <p className="muted">{t("howPage.menuVsShopping.description")}</p>
      </article>

      <article className="card" style={{ padding: "12px" }}>
        <h2 style={{ margin: "0 0 6px", fontSize: "22px" }}>4) {t("howPage.pro.title")}</h2>
        <ul style={{ margin: 0, paddingLeft: "18px", color: "var(--text-secondary)" }}>
          <li>{t("howPage.pro.features.aiTranslation")}</li>
          <li>{t("howPage.pro.features.importByPhotoLink")}</li>
          <li>{t("howPage.pro.features.imageGeneration")}</li>
          <li>{t("howPage.pro.features.multipleMenus")}</li>
          <li>{t("howPage.pro.features.advancedFilters")}</li>
        </ul>
      </article>
    </section>
  );
}

