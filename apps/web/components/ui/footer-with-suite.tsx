"use client";

import { cn } from "@/lib/utils";

interface NavLink {
  text: string;
  url: string;
}

interface FooterWithSuiteProps {
  brandName?: string;
  tagline?: string;
  navLinks?: NavLink[];
  socialLinks?: NavLink[];
  description?: string;
  ctaText?: string;
  ctaUrl?: string;
  email?: string;
  copyright?: string;
  className?: string;
}

const defaultNavLinks: NavLink[] = [{ text: "Mission theater", url: "#" }];

const defaultSocialLinks: NavLink[] = [
  { text: "GitHub", url: "https://github.com/paritoshk/supply_chain_recursive_agent" },
];

export default function FooterWithSuite({
  brandName = "Supplier Chief",
  tagline = "",
  navLinks = defaultNavLinks,
  socialLinks = defaultSocialLinks,
  description = "",
  ctaText = "",
  ctaUrl = "#",
  email = "",
  copyright = "",
  className,
}: FooterWithSuiteProps) {
  return (
    <footer
      className={cn(
        "w-full relative overflow-hidden bg-white dark:bg-neutral-950 select-none",
        className,
      )}
    >
      <div className="grid grid-cols-2 gap-8 px-8 pt-12 pb-4 md:px-12">
        <div className="flex flex-col gap-0">
          {navLinks.map((link, i) => (
            <a
              key={i}
              href={link.url}
              {...(/^https?:/.test(link.url) ? { target: "_blank", rel: "noreferrer" } : {})}
              className="py-0.75 text-[11px] tracking-[0.14em] uppercase text-neutral-900 dark:text-neutral-100 hover:text-neutral-400 dark:hover:text-neutral-500 transition-colors duration-200"
            >
              {link.text}
            </a>
          ))}

          <div className="h-5" />

          {socialLinks.map((link, i) => (
            <a
              key={i}
              href={link.url}
              {...(/^https?:/.test(link.url) ? { target: "_blank", rel: "noreferrer" } : {})}
              className="py-0.75 text-[11px] tracking-[0.14em] uppercase text-neutral-900 dark:text-neutral-100 hover:text-neutral-400 dark:hover:text-neutral-500 transition-colors duration-200"
            >
              {link.text}
            </a>
          ))}
        </div>

        <div className="flex flex-col gap-0">
          <p className="text-[11px] tracking-[0.12em] uppercase text-neutral-900 dark:text-neutral-100 leading-relaxed">
            {description}
          </p>

          <div className="h-5" />

          <a
            href={ctaUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] tracking-[0.14em] uppercase text-neutral-900 dark:text-neutral-100 hover:text-neutral-400 dark:hover:text-neutral-500 transition-colors duration-200"
          >
            {ctaText}
          </a>

          <div className="h-4" />

          {email && (
          <a
            href={`mailto:${email}`}
            className="text-[11px] tracking-[0.14em] uppercase text-neutral-900 dark:text-neutral-100 hover:text-neutral-400 dark:hover:text-neutral-500 transition-colors duration-200 break-all"
          >
            {email}
          </a>
          )}

          <div className="h-4" />

          <p className="text-[11px] tracking-[0.12em] uppercase text-neutral-400 dark:text-neutral-500">
            {copyright}
          </p>
        </div>
      </div>

      <p
        className="inset-x-0 text-center font-display font-light tracking-[-0.03em] text-neutral-900 dark:text-neutral-100"
        style={{ fontSize: "clamp(3rem, 15vw, 13rem)" }}
      >
        {brandName}
      </p>

      <div className="flex items-center justify-between px-8 md:px-12 py-3 border-t border-neutral-200 dark:border-neutral-800 mt-1">
        <p className="text-[10px] tracking-[0.14em] uppercase text-neutral-400 dark:text-neutral-500">
          {tagline}
        </p>
      </div>
    </footer>
  );
}

export { FooterWithSuite };


