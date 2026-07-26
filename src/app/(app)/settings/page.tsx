import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { roleAtLeast } from "@/server/roles";
import { ChannelIntegrationsList } from "./channel-integrations";
import { GlossarySection } from "./glossary-section";
import { OrgSettingsForm } from "./org-settings-form";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user || !roleAtLeast(session.user.role, "ADMINISTRATOR")) {
    redirect("/inbox");
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold text-foreground">Settings</h1>

      <OrgSettingsForm />

      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-foreground">Channel integrations</h2>
        <ChannelIntegrationsList />
      </div>

      <GlossarySection />
    </div>
  );
}
