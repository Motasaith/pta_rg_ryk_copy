import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PTA — Open World Pakistan',
  description:
    'An open-world browser game set in Rahim Garden City, R.Y. Khan. Drive, shoot, explore and find Mom\'s eight lost things. Runs entirely in your browser.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b1116',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
