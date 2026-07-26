import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { roleAtLeast } from "@/server/roles";
import { TelegramSettingsSection } from "./telegram-section";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user || !roleAtLeast(session.user.role, "ADMINISTRATOR")) {
    redirect("/inbox");
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
        <p className="max-w-2xl text-sm text-muted">
          Org settings, glossary management, and data retention controls are built in Phase 7. The
          Telegram section below is Phase 6&rsquo;s minimal channel-connection UI — full channel
          integrations list/polish is Phase 7.
        </p>
      </div>
      <TelegramSettingsSection />
    </div>
  );
}
