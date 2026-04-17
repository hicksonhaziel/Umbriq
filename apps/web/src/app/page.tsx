import Image from "next/image";
import { Footer } from "@/components/landing/footer";
import { Header } from "@/components/landing/header";
import {
  ArrowRight,
  Bolt,
  Building,
  Check,
  ChevronDown,
  Eye,
  PlayCircle,
  Shield,
} from "@/components/landing/icons";
import { WaitlistForm } from "@/components/landing/waitlist-form";

const steps = [
  {
    step: "01",
    title: "Create Private RFQ",
    description:
      "Define parameters for large block trades without exposing intent to public mempools or order books.",
  },
  {
    step: "02",
    title: "Receive Quotes",
    description:
      "Get competitive, actionable quotes from a curated network of vetted institutional liquidity providers.",
  },
  {
    step: "03",
    title: "Settle Privately",
    description:
      "Execute directly via smart contracts with atomic settlement and minimal information leakage.",
  },
  {
    step: "04",
    title: "Audit Selectively",
    description:
      "Grant read-only access to compliance teams or auditors without publicizing full trade details.",
  },
];

const faqs = [
  {
    q: "Is this a public order book?",
    a: "No. Umbriq operates as a private RFQ network. Orders are not broadcast to standard public order books.",
  },
  {
    q: "Who sees my RFQ?",
    a: "Only counterparties you authorize for that request. Disclosure is controlled by the initiating desk.",
  },
  {
    q: "How does compliance access work?",
    a: "Umbriq supports read-only selective visibility for approved compliance users without granting trading permissions.",
  },
  {
    q: "Which wallets and chains are supported first?",
    a: "Umbriq is Solana-native and designed for institutional wallet integrations over time.",
  },
  {
    q: "How can I get early access?",
    a: "Join the waitlist. We are onboarding institutional and treasury-focused users in phases.",
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-[#101419] text-[#e0e2ea]">
      <Header />

      <main className="pb-24 pt-32">
        <section className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-14 px-6 lg:grid-cols-2 lg:items-center lg:px-8">
          <div className="z-10 flex flex-col gap-8">
            <div>
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[#1c2025] bg-[#181c21] px-3 py-1.5">
                <span className="h-2 w-2 animate-pulse rounded-full bg-[#4fdbc8]" />
                <span className="text-xs font-semibold uppercase tracking-wider text-[#bbcac6]">
                  Private Execution on Solana
                </span>
              </div>
              <h1 className="mb-6 text-5xl font-extrabold leading-[1.05] tracking-[-0.02em] text-white md:text-6xl">
                Trade in size without broadcasting intent.
              </h1>
              <p className="max-w-xl text-lg leading-relaxed text-[#bbcac6]">
                Umbriq gives institutions private RFQ execution with selective compliance
                visibility. Execute large blocks securely, away from public order books.
              </p>
            </div>

            <div className="flex flex-col gap-4 sm:flex-row">
              <a
                href="#join"
                className="inline-flex items-center justify-center gap-2 rounded-[10px] bg-[#14b8a6] px-8 py-3.5 text-base font-bold text-[#003731] transition hover:bg-[#0d9488]"
              >
                Request Early Access
                <ArrowRight className="h-5 w-5" />
              </a>
              <a
                href="#product"
                className="inline-flex items-center justify-center gap-2 rounded-[10px] border border-[#3c4947] bg-white/5 px-8 py-3.5 text-base font-semibold text-white transition hover:bg-white/10"
              >
                <PlayCircle className="h-5 w-5" />
                View How It Works
              </a>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-4 border-t border-[#181c21] pt-8 sm:grid-cols-4">
              <div className="flex items-center gap-2 text-sm text-[#bbcac6]">
                <Shield className="h-4 w-4 text-[#4fdbc8]" />
                <span>Private RFQ Flow</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-[#bbcac6]">
                <Eye className="h-4 w-4 text-[#4fdbc8]" />
                <span>Selective Transparency</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-[#bbcac6]">
                <Bolt className="h-4 w-4 text-[#4fdbc8]" />
                <span>Solana Native</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-[#bbcac6]">
                <Building className="h-4 w-4 text-[#4fdbc8]" />
                <span>Built for Institutions</span>
              </div>
            </div>
          </div>

          <div id="join" className="relative z-10 w-full max-w-md lg:ml-auto">
            <div className="absolute -inset-4 rounded-full bg-[#14b8a6]/20 blur-[100px]" />
            <div className="relative rounded-xl border border-[#3c4947]/40 bg-[#31353b]/40 p-8 backdrop-blur-xl">
              <div className="mb-8">
                
                <h3 className="mb-2 text-xl font-bold text-white">Secure Your Allocation</h3>
                <p className="text-sm text-[#bbcac6]">
                  Join the waitlist for priority onboarding and early API access.
                </p>
              </div>
              <WaitlistForm />
            </div>
          </div>
        </section>

        <div className="mx-auto my-24 w-full max-w-7xl px-6 lg:px-8">
          <div className="h-px w-full bg-gradient-to-r from-transparent via-[#1c2025] to-transparent" />
        </div>

        <section id="product" className="mx-auto mb-32 w-full max-w-7xl px-6 lg:px-8">
          <div className="mb-16">
            <h2 className="mb-4 text-3xl font-bold tracking-tight text-white md:text-4xl">
              The Sovereign Workflow
            </h2>
            <p className="max-w-2xl text-lg text-[#bbcac6]">
              A protocol designed for institutional capital allocators to manage execution quality
              with privacy controls.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
            {steps.map((item) => (
              <article
                key={item.step}
                className="group relative overflow-hidden rounded-xl border border-[#3c4947]/40 bg-[#0a0e13] p-8 transition hover:bg-[#181c21]"
              >
                <div className="absolute right-0 top-0 p-6 opacity-10 transition group-hover:opacity-20">
                  <span className="text-8xl font-black text-white">{item.step}</span>
                </div>
                <h3 className="relative z-10 mb-3 text-xl font-bold text-white">{item.title}</h3>
                <p className="relative z-10 text-sm leading-relaxed text-[#bbcac6]">
                  {item.description}
                </p>
              </article>
            ))}
          </div>
        </section>

        <section id="security" className="mx-auto mb-32 w-full max-w-7xl px-6 lg:px-8">
          <div className="flex flex-col gap-14 rounded-[20px] border border-[#3c4947]/40 bg-[#1c2025] p-10 md:p-14 lg:flex-row lg:items-center">
            <div className="flex-1">
              <h2 className="mb-6 text-3xl font-bold tracking-tight text-white md:text-4xl">
                Privacy by Default.
                <br />
                Compliance by Choice.
              </h2>
              <p className="mb-8 text-lg leading-relaxed text-[#bbcac6]">
                Umbriq separates execution from visibility. Trading strategy remains private while
                compliance users can access controlled disclosures.
              </p>
              <ul className="space-y-5">
                {[
                  {
                    title: "Controlled Disclosure",
                    copy: "Only selected counterparties and approved roles can view request details.",
                  },
                  {
                    title: "Signed Workflows",
                    copy: "Critical actions are signed and timestamped for robust internal controls.",
                  },
                  {
                    title: "Role-Based Access",
                    copy: "Separate privileges for traders, risk managers, and compliance reviewers.",
                  },
                ].map((item) => (
                  <li key={item.title} className="flex items-start gap-4">
                    <span className="mt-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[#181c21]">
                      <Check className="h-4 w-4 text-[#4fdbc8]" />
                    </span>
                    <div>
                      <h4 className="mb-1 font-bold text-white">{item.title}</h4>
                      <p className="text-sm text-[#bbcac6]">{item.copy}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <div className="relative w-full flex-1">
              <div className="absolute inset-0 rounded-full bg-[#14b8a6]/5 blur-[80px]" />
              <div className="relative overflow-hidden rounded-xl border border-[#3c4947]/40 bg-[#0a0e13] p-6 font-mono text-sm">
                <div className="mb-4 flex items-center justify-between border-b border-[#181c21] pb-4">
                  <span className="text-xs uppercase tracking-wider text-[#bbcac6]">
                    Access Policy Matrix
                  </span>
                  <div className="flex gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-[#31353b]" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#31353b]" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#31353b]" />
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="flex items-center justify-between rounded bg-[#181c21] p-3">
                    <span className="text-slate-400">Trade Execution</span>
                    <span className="text-[#4fdbc8]">Trader_Role</span>
                  </div>
                  <div className="flex items-center justify-between rounded bg-[#181c21] p-3">
                    <span className="text-slate-400">View Active RFQs</span>
                    <span className="text-[#4fdbc8]">Trader_Role, Risk_Role</span>
                  </div>
                  <div className="flex items-center justify-between rounded bg-[#181c21] p-3">
                    <span className="text-slate-400">Export Audit Log</span>
                    <span className="text-[#4fdbc8]">Compliance_Role</span>
                  </div>
                  <div className="flex items-center justify-between rounded bg-[#181c21] p-3">
                    <span className="text-slate-400">Public Visibility</span>
                    <span className="text-[#ffb4ab]">None</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="faq" className="mx-auto mb-32 w-full max-w-3xl px-6">
          <div className="mb-12 text-center">
            <h2 className="text-3xl font-bold text-white">Frequently Asked Questions</h2>
          </div>
          <div className="space-y-4">
            {faqs.map((faq) => (
              <details
                key={faq.q}
                className="group rounded-lg border border-[#3c4947]/40 bg-[#0a0e13] [&_summary::-webkit-details-marker]:hidden"
              >
                <summary className="flex cursor-pointer items-center justify-between p-6 font-semibold text-white">
                  {faq.q}
                  <ChevronDown className="h-5 w-5 text-[#4fdbc8] transition duration-300 group-open:-rotate-180" />
                </summary>
                <div className="px-6 pb-6 text-sm leading-relaxed text-[#bbcac6]">{faq.a}</div>
              </details>
            ))}
          </div>
        </section>

        <section className="mx-auto mb-16 w-full max-w-5xl px-6 text-center lg:px-8">
          <div className="relative overflow-hidden rounded-2xl border border-[#3c4947]/40 bg-[#181c21] p-12 md:p-16">
            <div className="pointer-events-none absolute inset-0 rounded-full bg-[#14b8a6]/10 blur-[120px]" />
            <div className="relative z-10">
              <h2 className="mb-4 text-4xl font-extrabold tracking-tight text-white">
                Private execution.
                <br />
                Selective transparency.
              </h2>
              <p className="mx-auto mb-10 max-w-lg text-lg text-[#bbcac6]">
                Secure your allocation in Umbriq&apos;s institutional RFQ network on Solana.
              </p>
              <a
                href="#join"
                className="inline-flex rounded-[10px] bg-[#14b8a6] px-10 py-4 text-lg font-bold text-[#003731] transition hover:bg-[#0d9488]"
              >
                Join Waitlist
              </a>
            </div>
          </div>
        </section>
      </main>

      <Footer />

      <div className="fixed inset-x-0 bottom-4 z-40 px-6 md:hidden">
        <a
          href="#join"
          className="block rounded-[10px] border border-[#1f2937] bg-[#14b8a6] px-4 py-3 text-center text-sm font-bold text-[#003731]"
        >
          Join Waitlist
        </a>
      </div>
    </div>
  );
}
