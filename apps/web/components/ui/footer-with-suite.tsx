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
        "w-full relative overflow-hidden bg-[#141311] text-[#FDFDFC] select-none",
        className,
      )}
    >
      <div className="grid grid-cols-2 gap-8 px-8 pt-16 pb-6 md:px-[64px]">
        <div className="flex flex-col gap-0">
          {navLinks.map((link, i) => (
            <a
              key={i}
              href={link.url}
              {...(/^https?:/.test(link.url) ? { target: "_blank", rel: "noreferrer" } : {})}
              className="py-1 font-mono text-[12px] tracking-[0.06em] uppercase text-[#FDFDFC] hover:text-[#F25C05] transition-colors duration-200"
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
              className="py-1 font-mono text-[12px] tracking-[0.06em] uppercase text-[#FDFDFC] hover:text-[#F25C05] transition-colors duration-200"
            >
              {link.text}
            </a>
          ))}
        </div>

        <div className="flex flex-col gap-0">
          <p className="font-mono text-[12px] tracking-[0.06em] uppercase text-[#B5B3B0] leading-relaxed max-w-[520px]">
            {description}
          </p>

          <div className="h-5" />

          <a
            href={ctaUrl}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[12px] tracking-[0.06em] uppercase text-[#FDFDFC] hover:text-[#F25C05] transition-colors duration-200"
          >
            {ctaText}
          </a>

          <div className="h-4" />

          {email && (
          <a
            href={`mailto:${email}`}
            className="font-mono text-[12px] tracking-[0.06em] uppercase text-[#FDFDFC] hover:text-[#F25C05] transition-colors duration-200 break-all"
          >
            {email}
          </a>
          )}

          <div className="h-4" />

          <p className="font-mono text-[12px] tracking-[0.06em] uppercase text-[#908E87]">
            {copyright}
          </p>
        </div>
      </div>

      <p
        className="inset-x-0 text-center font-display font-light tracking-[-0.03em] text-[#FDFDFC] leading-[1.05] py-8"
        style={{ fontSize: "clamp(3rem, 15vw, 13rem)" }}
      >
        {brandName}
      </p>

      <div className="flex items-center justify-between px-8 md:px-[64px] py-4 border-t border-[#3D3B39] mt-1">
        <p className="font-mono text-[12px] tracking-[0.06em] uppercase text-[#908E87]">
          {tagline}
        </p>
      </div>
    </footer>
  );
}

export { FooterWithSuite };


