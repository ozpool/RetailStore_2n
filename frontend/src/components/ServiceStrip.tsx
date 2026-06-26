const SERVICES = [
  {
    title: "HAND-CHECKED LISTINGS",
    body: "Every piece looked over before it goes up",
    icon: (
      <>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M9 12l2 2 4-4" />
      </>
    ),
  },
  {
    title: "FLAWS ALWAYS DISCLOSED",
    body: "Condition stated plainly, never hidden",
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16h.01" />
      </>
    ),
  },
  {
    title: "FREE 14-DAY RETURNS",
    body: "If it isn't as described, send it back",
    icon: (
      <>
        <path d="M3 12a9 9 0 1015.5-6.2" />
        <path d="M21 3v6h-6" />
      </>
    ),
  },
];

/** Reference's trust row: dark ringed icon, caps title, grey line beneath. */
export default function ServiceStrip() {
  return (
    <section className="px-6 py-20">
      <div className="mx-auto grid max-w-[1400px] gap-12 text-center sm:grid-cols-3">
        {SERVICES.map((service) => (
          <div key={service.title} className="flex flex-col items-center">
            <span className="flex h-20 w-20 items-center justify-center rounded-full bg-ink/15">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-ink text-paper">
                <svg
                  viewBox="0 0 24 24"
                  className="h-7 w-7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  {service.icon}
                </svg>
              </span>
            </span>
            <h3 className="mt-6 text-lg font-semibold tracking-wide text-ink">
              {service.title}
            </h3>
            <p className="mt-2 text-sm text-ink-dim">{service.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
