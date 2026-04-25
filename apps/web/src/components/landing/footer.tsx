import Image from "next/image";

export function Footer() {
  return (
    <footer className="w-full border-t border-white/5 bg-[#0a0e13] py-12">
      <div className="mx-auto grid w-full max-w-7xl grid-cols-2 gap-8 px-6 lg:grid-cols-4 lg:px-8">
        <div className="col-span-2 lg:col-span-1">
          <div className="mb-5 flex items-center gap-3">
            <Image
              src="/brand/icon.png"
              alt="Umbriq logo"
              width={40}
              height={40}
              className="rounded"
              style={{ height: "auto" }}
            />
            <span className="text-lg font-bold text-white">Umbriq</span>
          </div>
          <p className="text-sm leading-relaxed tracking-wide text-slate-500">
            Institutional-grade execution.
            <br />
            Private RFQ infrastructure.
          </p>
        </div>

        <div>
          <h5 className="mb-4 text-sm font-semibold text-white">Platform</h5>
          <ul className="space-y-3">
            <li>
              <a className="text-sm text-slate-500 transition-colors hover:text-[#14b8a6]" href="#">
                Documentation
              </a>
            </li>
            <li>
              <a className="text-sm text-slate-500 transition-colors hover:text-[#14b8a6]" href="#">
                Compliance Framework
              </a>
            </li>
          </ul>
        </div>

        <div>
          <h5 className="mb-4 text-sm font-semibold text-white">Legal</h5>
          <ul className="space-y-3">
            <li>
              <a className="text-sm text-slate-500 transition-colors hover:text-[#14b8a6]" href="#">
                Terms of Service
              </a>
            </li>
            <li>
              <a className="text-sm text-slate-500 transition-colors hover:text-[#14b8a6]" href="#">
                Privacy Policy
              </a>
            </li>
          </ul>
        </div>

        <div className="col-span-2 flex items-end lg:col-span-1">
          <p className="text-xs tracking-wide text-slate-600">
            © 2026 Umbriq. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
