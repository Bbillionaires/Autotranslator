import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { Nav } from "./nav";
import { TranslationDisclosureBanner } from "./translation-disclosure-banner";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await auth();

  if (!session?.user) {
    redirect("/sign-in");
  }

  return (
    <div className="flex min-h-full flex-1 flex-col bg-background">
      <Nav role={session.user.role} userName={session.user.name} userEmail={session.user.email} />
      {/* M2 fix (docs/review-report.md): general, app-shell-wide translation-quality
          disclosure — independent of and in addition to the per-conversation opt-in
          HighRiskBanner (inbox/[conversationId]/high-risk-banner.tsx). */}
      <TranslationDisclosureBanner />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
