import type { Metadata } from "next";
import { Geist_Mono, Inter, Poppins } from "next/font/google";
import SamePageLinkScroll from "@/components/SamePageLinkScroll";
import { AuthProvider } from "@/lib/AuthContext";
import { CartProvider } from "@/lib/CartContext";
import { NotificationProvider } from "@/lib/NotificationContext";
import { WishlistProvider } from "@/lib/WishlistContext";
import "./globals.css";

// Inter for UI and body, Poppins for headings — the type pairing the reference
// design uses.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "RetailStore_2n — Beautifully Secondhand",
  description:
    "A marketplace for pre-loved furniture, clothing, and objects — chosen for character, not condition. Buy something with a story, or sell the one taking up space in your closet.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${geistMono.variable} ${poppins.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <AuthProvider>
          {/* Inside AuthProvider: the wishlist belongs to a signed-in user, so
              it has to be able to read who that is. */}
          <WishlistProvider>
            <CartProvider>
              <NotificationProvider>
                <SamePageLinkScroll />
                {children}
              </NotificationProvider>
            </CartProvider>
          </WishlistProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
