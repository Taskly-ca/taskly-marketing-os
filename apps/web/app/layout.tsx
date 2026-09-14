import type { Metadata, Viewport } from 'next';
import { Manrope, Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';

const manrope = Manrope({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-manrope' });
const jakarta = Plus_Jakarta_Sans({ subsets: ['latin'], weight: ['500', '600'], variable: '--font-jakarta' });

export const metadata: Metadata = {
  title: 'Taskly Marketing OS',
  description: 'Ask the market. Every figure with the sentence it came from.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FAFAFA' },
    { media: '(prefers-color-scheme: dark)', color: '#121211' },
  ],
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${jakarta.variable}`} suppressHydrationWarning>
      <head>
        {/* Before first paint, so a chosen theme never flashes the other one. Storage can throw in a private window. */}
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem('tmos.theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}` }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
