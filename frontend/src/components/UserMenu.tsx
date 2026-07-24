"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import {
  CancelIcon,
  CartIcon,
  HeartIcon,
  LogoutIcon,
  OrdersIcon,
  StarIcon,
  StoreIcon,
  UserIcon,
} from "@/components/AccountIcons";
import Avatar from "@/components/Avatar";
import type { User } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import { useDismissable } from "@/lib/useDismissable";

const itemClass =
  "flex items-center gap-3 rounded px-3 py-2 text-sm text-ink transition hover:bg-blush";

function Item({
  href,
  icon,
  label,
  onNavigate,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  onNavigate: () => void;
}) {
  return (
    <Link href={href} role="menuitem" onClick={onNavigate} className={itemClass}>
      <span className="shrink-0 text-ink-dim">{icon}</span>
      {label}
    </Link>
  );
}

export default function UserMenu({ user }: { user: User }) {
  const { logout } = useAuth();
  const { open, setOpen, ref } = useDismissable<HTMLDivElement>();
  const close = () => setOpen(false);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Your account"
        className="rounded-full transition hover:brightness-90"
      >
        <Avatar name={user.name} src={user.avatarUrl} size={36} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-64 rounded border border-line bg-paper-card p-2 shadow-lg"
        >
          <div className="flex items-center gap-3 px-3 py-2">
            <Avatar name={user.name} src={user.avatarUrl} size={36} />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{user.name}</p>
              <p className="truncate text-xs text-ink-dim">{user.email}</p>
            </div>
          </div>

          <div className="my-1 h-px bg-line" />

          <Item href="/account" icon={<UserIcon />} label="Your account" onNavigate={close} />
          <Item href="/account/orders" icon={<OrdersIcon />} label="My orders" onNavigate={close} />
          <Item href="/account/reviews" icon={<StarIcon />} label="My reviews" onNavigate={close} />
          <Item
            href="/account/cancellations"
            icon={<CancelIcon />}
            label="My cancellations"
            onNavigate={close}
          />
          <Item href="/cart" icon={<CartIcon />} label="My cart" onNavigate={close} />
          <Item href="/wishlist" icon={<HeartIcon />} label="Wishlist" onNavigate={close} />
          <Item
            href={user.isSeller ? "/seller" : "/account"}
            icon={<StoreIcon />}
            label={user.isSeller ? "Seller dashboard" : "Start selling"}
            onNavigate={close}
          />

          <div className="my-1 h-px bg-line" />

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              logout();
            }}
            className={`${itemClass} w-full text-left`}
          >
            <span className="shrink-0 text-ink-dim">
              <LogoutIcon />
            </span>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
