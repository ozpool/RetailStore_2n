/** Icon set for the account grid. Stroke style matches the rest of the UI. */

const props = {
  viewBox: "0 0 24 24",
  className: "h-5 w-5",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const OrdersIcon = () => (
  <svg {...props}>
    <path d="M3 7l9-4 9 4-9 4-9-4z" />
    <path d="M3 7v10l9 4 9-4V7" />
    <path d="M12 11v10" />
  </svg>
);

export const HeartIcon = () => (
  <svg {...props}>
    <path d="M20.8 5.6a5 5 0 00-7.1 0L12 7.3l-1.7-1.7a5 5 0 10-7.1 7.1L12 21.5l8.8-8.8a5 5 0 000-7.1z" />
  </svg>
);

export const CartIcon = () => (
  <svg {...props}>
    <circle cx="9" cy="20" r="1.5" />
    <circle cx="18" cy="20" r="1.5" />
    <path d="M2 3h2.5l2.4 11.2a2 2 0 002 1.6h8.6a2 2 0 002-1.5L21 7H6" />
  </svg>
);

export const LockIcon = () => (
  <svg {...props}>
    <rect x="4" y="10" width="16" height="10" rx="2" />
    <path d="M8 10V7a4 4 0 018 0v3" />
  </svg>
);

export const AddressIcon = () => (
  <svg {...props}>
    <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1116 0z" />
    <circle cx="12" cy="10" r="2.5" />
  </svg>
);

export const CardIcon = () => (
  <svg {...props}>
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M2 10h20" />
  </svg>
);

export const TagIcon = () => (
  <svg {...props}>
    <path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0l-7.2-7.2A2 2 0 013 12V5a2 2 0 012-2h7a2 2 0 011.4.6l7.2 7.2a2 2 0 010 2.6z" />
    <circle cx="7.5" cy="7.5" r="1.5" />
  </svg>
);

export const ShieldIcon = () => (
  <svg {...props}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
);

export const BellIcon = () => (
  <svg {...props}>
    <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 01-3.5 0" />
  </svg>
);

export const StarIcon = () => (
  <svg {...props}>
    <path d="M12 3l2.6 5.6 6.1.6-4.6 4.1 1.3 6-5.4-3.1-5.4 3.1 1.3-6L3.3 9.2l6.1-.6z" />
  </svg>
);

export const CancelIcon = () => (
  <svg {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9 9l6 6M15 9l-6 6" />
  </svg>
);

export const UserIcon = () => (
  <svg {...props}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20a7 7 0 0114 0" />
  </svg>
);

export const StoreIcon = () => (
  <svg {...props}>
    <path d="M4 9h16v11H4z" />
    <path d="M4 9l2-5h12l2 5" />
    <path d="M9 20v-6h6v6" />
  </svg>
);

export const LogoutIcon = () => (
  <svg {...props}>
    <path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3" />
    <path d="M10 8l-4 4 4 4M6 12h9" />
  </svg>
);

export const WalletIcon = () => (
  <svg {...props}>
    <path d="M3 7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
    <path d="M16 12h2" />
  </svg>
);
