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
  // A game canvas must not pinch-zoom or double-tap-zoom: both turn an aim gesture into
  // a page transform. viewportFit lets the HUD run under a notch, and the safe-area
  // insets in globals.css keep the controls out from under it.
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#0b1116',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
