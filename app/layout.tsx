import "./globals.css";
import Header from "./header";
import HouseAssistant from "./components/HouseAssistant";
import ProActivationToast from "./components/ProActivationToast";
import { I18nProvider } from "./components/I18nProvider";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Planotto",
  description: "Планируй еду, готовь и покупай",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru">
      <body>
        <I18nProvider>
          <Header />
          <ProActivationToast />
          <main className="container main">{children}</main>
          <HouseAssistant />
          <footer className="footer">
            <div className="container footer__inner">
              <span>Planotto</span>
            </div>
          </footer>
        </I18nProvider>
      </body>
    </html>
  );
}
