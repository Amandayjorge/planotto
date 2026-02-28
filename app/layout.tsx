import "./globals.css";
import Header from "./header";
import HouseAssistant from "./components/HouseAssistant";
import ProActivationToast from "./components/ProActivationToast";
import { I18nProvider } from "./components/I18nProvider";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Planotto",
  description: "Планируй еду, готовь и покупай",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    shortcut: ["/favicon.ico"],
  },
  appleWebApp: {
    capable: true,
    title: "Planotto",
    statusBarStyle: "default",
  },
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
