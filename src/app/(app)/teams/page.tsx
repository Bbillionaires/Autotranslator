import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { roleAtLeast } from "@/server/roles";

export default async function TeamsPage() {
  const session = await auth();
  if (!session?.user || !roleAtLeast(session.user.role, "MANAGER")) {
    redirect("/inbox");
  }

  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold text-foreground">Teams</h1>
      <p className="max-w-2xl text-sm text-muted">
        Team creation, membership management, and conversation assignment are built in Phase 7. This
        page is only shown to Manager+ roles, confirming role-gated nav visibility works.
      </p>
    </div>
  );
}
