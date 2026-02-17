import "./globals.css";
import Header from "./header";
import HouseAssistant from "./components/HouseAssistant";
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
        <Header />
        <main className="container main">{children}</main>
        <HouseAssistant />
        <footer className="footer">
          <div className="container footer__inner">
            <span>Planotto</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
