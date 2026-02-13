import "./globals.css";
import Header from "./header";
import HouseAssistant from "./components/HouseAssistant";

export const metadata = {
  title: "Planotto",
  description: "Планируй еду, готовь и покупай",
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
