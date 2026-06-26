import Footer from "@/components/Footer";
import Nav from "@/components/Nav";

export default function InfoPage({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow: string;
  title: string;
  intro?: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <span className="text-xs font-medium tracking-wide text-gold-dim uppercase">
            {eyebrow}
          </span>
          <h1 className="mt-3 font-serif text-4xl font-medium tracking-tight text-ink">
            {title}
          </h1>
          {intro && <p className="mt-4 text-lg text-ink-dim">{intro}</p>}

          <div
            className="mt-10 space-y-6
              [&_h2]:font-serif [&_h2]:text-2xl [&_h2]:font-medium [&_h2]:text-ink [&_h2]:mt-10
              [&_p]:text-ink-dim [&_p]:leading-relaxed
              [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-2 [&_ul]:text-ink-dim
              [&_li]:leading-relaxed
              [&_strong]:font-semibold [&_strong]:text-ink"
          >
            {children}
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
