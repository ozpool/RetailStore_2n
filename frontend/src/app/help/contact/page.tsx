"use client";

import { useState } from "react";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";

export default function ContactPage() {
  const [sent, setSent] = useState(false);

  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-16">
        <div className="mx-auto max-w-xl">
          <span className="text-xs font-medium tracking-wide text-gold-dim uppercase">
            Help
          </span>
          <h1 className="mt-3 font-serif text-4xl font-medium tracking-tight text-ink">
            Contact us
          </h1>
          <p className="mt-4 text-lg text-ink-dim">
            Order problems, seller questions, something that looked wrong — write
            it below. A person reads these, not a bot.
          </p>

          {sent ? (
            <div className="mt-10 rounded-3xl border border-line bg-paper-card p-8 text-center">
              <p className="font-serif text-xl text-ink">Got it.</p>
              <p className="mt-2 text-sm text-ink-dim">
                We usually reply within one business day.
              </p>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setSent(true);
              }}
              className="mt-10 space-y-4"
            >
              <div>
                <label htmlFor="name" className="text-sm font-medium text-ink">
                  Name
                </label>
                <input
                  id="name"
                  type="text"
                  required
                  className="mt-1.5 w-full rounded-2xl border border-line bg-paper-card px-3.5 py-2.5 text-sm text-ink outline-none focus:border-gold"
                />
              </div>

              <div>
                <label htmlFor="email" className="text-sm font-medium text-ink">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  className="mt-1.5 w-full rounded-2xl border border-line bg-paper-card px-3.5 py-2.5 text-sm text-ink outline-none focus:border-gold"
                />
              </div>

              <div>
                <label htmlFor="topic" className="text-sm font-medium text-ink">
                  Topic
                </label>
                <select
                  id="topic"
                  defaultValue="order"
                  className="mt-1.5 w-full rounded-2xl border border-line bg-paper-card px-3.5 py-2.5 text-sm text-ink outline-none focus:border-gold"
                >
                  <option value="order">An order</option>
                  <option value="selling">Selling on RetailStore_2n</option>
                  <option value="report">Reporting a listing</option>
                  <option value="other">Something else</option>
                </select>
              </div>

              <div>
                <label htmlFor="message" className="text-sm font-medium text-ink">
                  Message
                </label>
                <textarea
                  id="message"
                  required
                  rows={5}
                  className="mt-1.5 w-full rounded-2xl border border-line bg-paper-card px-3.5 py-2.5 text-sm text-ink outline-none focus:border-gold"
                />
              </div>

              <button
                type="submit"
                className="seam-glow w-full rounded-full bg-gold-dim px-6 py-3 text-sm font-semibold text-paper transition hover:brightness-90"
              >
                Send message
              </button>
            </form>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
