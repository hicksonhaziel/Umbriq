import Image from "next/image";

export function Header() {
  return (
    <nav className="fixed inset-x-0 top-0 z-50 border-b border-[#1c2025] bg-[#101419]/80 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-4 lg:px-8">
        <a href="#" className="flex items-center gap-3">
          <Image
            src="/brand/icon.png"
            alt="Umbriq logo"
            width={32}
            height={32}
            className="rounded"
            priority
          />
          <span className="text-xl font-bold tracking-tight text-white">Umbriq</span>
        </a>

        <div className="hidden items-center gap-8 md:flex">
          <a className="text-sm text-slate-400 transition-colors hover:text-white" href="#product">
            Platform
          </a>
          <a className="text-sm text-slate-400 transition-colors hover:text-white" href="#security">
            Security
          </a>
          <a className="text-sm text-slate-400 transition-colors hover:text-white" href="#faq">
            FAQ
          </a>
        </div>

        <a
          href="#join"
          className="rounded-[10px] bg-[#14b8a6] px-5 py-2.5 text-sm font-bold text-[#003731] transition hover:bg-[#0d9488]"
        >
          Join Waitlist
        </a>
      </div>
    </nav>
  );
}

