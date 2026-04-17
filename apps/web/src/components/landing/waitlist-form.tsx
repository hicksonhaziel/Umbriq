"use client";

import { FormEvent, useState } from "react";

type Status = "idle" | "success";

export function WaitlistForm() {
  const [status, setStatus] = useState<Status>("idle");

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("success");
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={onSubmit}>
      <div className="flex flex-col gap-1.5">
        <label className="text-sm text-[#bbcac6]" htmlFor="email">
          Work Email
        </label>
        <input
          required
          id="email"
          type="email"
          placeholder="name@institution.com"
          className="w-full rounded-[10px] border border-transparent bg-[#0a0e13] px-4 py-3 text-sm text-white placeholder:text-slate-600 outline-none transition focus:border-[#14b8a6]"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm text-[#bbcac6]" htmlFor="company">
          Company Name
        </label>
        <input
          required
          id="company"
          type="text"
          placeholder="Institution Name"
          className="w-full rounded-[10px] border border-transparent bg-[#0a0e13] px-4 py-3 text-sm text-white placeholder:text-slate-600 outline-none transition focus:border-[#14b8a6]"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm text-[#bbcac6]" htmlFor="role">
          Role
        </label>
        <select
          required
          id="role"
          defaultValue=""
          className="w-full cursor-pointer rounded-[10px] border border-transparent bg-[#0a0e13] px-4 py-3 text-sm text-white outline-none transition focus:border-[#14b8a6]"
        >
          <option value="" disabled>
            Select your role
          </option>
          <option value="trader">Trader</option>
          <option value="treasury">Treasury Manager</option>
          <option value="market-maker">Market Maker</option>
          <option value="compliance">Compliance</option>
          <option value="other">Other</option>
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="flex justify-between text-sm text-[#bbcac6]" htmlFor="message">
          <span>Message</span>
          <span className="text-slate-600">Optional</span>
        </label>
        <textarea
          id="message"
          rows={2}
          placeholder="Tell us about your execution needs..."
          className="w-full resize-none rounded-[10px] border border-transparent bg-[#0a0e13] px-4 py-3 text-sm text-white placeholder:text-slate-600 outline-none transition focus:border-[#14b8a6]"
        />
      </div>

      <label className="mt-1 flex items-start gap-3 text-xs text-[#bbcac6]" htmlFor="updates">
        <input
          id="updates"
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-[#1f2937] bg-[#0a0e13] text-[#14b8a6] focus:ring-[#14b8a6]"
        />
        <span>I agree to receive updates about Umbriq&apos;s early access program.</span>
      </label>

      <button
        type="submit"
        className="mt-2 w-full rounded-[10px] bg-[#14b8a6] px-4 py-3.5 text-sm font-bold text-[#003731] transition hover:bg-[#0d9488]"
      >
        Join Waitlist
      </button>

      {status === "success" ? (
        <p className="rounded-[10px] border border-[#1f2937] bg-[#0a0e13] px-3 py-2 text-sm text-[#22c55e]">
          You&apos;re on the list. We&apos;ll reach out soon.
        </p>
      ) : null}
    </form>
  );
}

