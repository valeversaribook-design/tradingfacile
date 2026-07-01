export const metadata = {
  title: "Luca Trading Definitivo",
  description: "Generatore report XAUUSD da CSV TradingView/OANDA"
};

export default function RootLayout({ children }) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  );
}
