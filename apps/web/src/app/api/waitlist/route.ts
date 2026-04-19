import { NextResponse } from "next/server";

const allowedRoles = new Set(["trader", "treasury", "market-maker", "compliance", "other"]);

type WaitlistPayload = {
  email?: unknown;
  role?: unknown;
  message?: unknown;
  wantsUpdates?: unknown;
};

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function POST(request: Request) {
  let payload: WaitlistPayload;

  try {
    payload = (await request.json()) as WaitlistPayload;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const role = typeof payload.role === "string" ? payload.role.trim() : "";
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  const wantsUpdates = payload.wantsUpdates === true;

  if (!email || !isValidEmail(email)) {
    return NextResponse.json({ error: "Please enter a valid work email." }, { status: 400 });
  }

  if (!role || !allowedRoles.has(role)) {
    return NextResponse.json({ error: "Please select a valid role." }, { status: 400 });
  }

  if (message.length > 1200) {
    return NextResponse.json(
      { error: "Message is too long. Keep it under 1200 characters." },
      { status: 400 }
    );
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return NextResponse.json(
      { error: "Server is missing Supabase configuration." },
      { status: 500 }
    );
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/waitlist_entries`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      email,
      role,
      message: message || null,
      wants_updates: wantsUpdates,
      source: "landing-page",
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text();

    if (response.status === 409) {
      return NextResponse.json({ ok: true, alreadyOnList: true }, { status: 200 });
    }

    console.error("Supabase waitlist insert failed:", bodyText);
    return NextResponse.json({ error: "Failed to save waitlist entry." }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
