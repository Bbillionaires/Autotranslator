/**
 * Conversation view — Phase 7. Server Component: loads the full conversation (contact,
 * channel account, assignment, messages) org-scoped, computes the outbound target language
 * via the same §3.4 `resolveTargetLanguage` chain the outbound service itself uses (so the
 * UI's "will be translated to" indicator can never drift from what actually happens on
 * send), and renders the thread + composer + sidebar + assignment controls.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { roleAtLeast } from "@/server/roles";
import { conversationRepository } from "@/server/repositories/conversationRepository";
import { messageRepository } from "@/server/repositories/messageRepository";
import { teamRepository } from "@/server/repositories/teamRepository";
import { userRepository } from "@/server/repositories/userRepository";
import { resolveTargetLanguage } from "@/server/translation/resolveLanguage";
import { NotFoundError } from "@/server/errors";
import { AssignmentPanel } from "./assignment-panel";
import { ContactSidebar } from "./contact-sidebar";
import { MessageThread } from "./message-thread";
import { Composer } from "./composer";
import { HighRiskBanner } from "./high-risk-banner";

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  const session = await auth();
  // Per-page guard, independent of `(app)/layout.tsx`'s own check — see inbox/page.tsx's
  // identical comment for why a layout-level redirect alone isn't sufficient here.
  if (!session?.user) {
    redirect("/sign-in");
  }
  const organizationId = session.user.organizationId;
  const role = session.user.role;

  let conversation;
  try {
    conversation = await conversationRepository.findDetailByIdInOrgOrThrow(organizationId, conversationId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      notFound();
    }
    throw error;
  }

  const [messages, users, teams] = await Promise.all([
    messageRepository.listByConversation(organizationId, conversationId, { take: 200 }),
    userRepository.listByOrg(organizationId),
    teamRepository.listByOrg(organizationId),
  ]);

  const targetLanguage = resolveTargetLanguage({
    conversationOverride: conversation.preferredLanguageOverride,
    contactPreferred: conversation.contact.preferredLanguage,
    contactDetected: conversation.contact.detectedLanguage,
    orgDefault: conversation.organization.defaultLanguage,
  });

  const canSend = roleAtLeast(role, "AGENT");
  const canAssign = roleAtLeast(role, "AGENT");

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold text-foreground">{conversation.contact.displayName}</h1>
            <p className="text-xs text-muted">{conversation.channelAccount.displayName}</p>
          </div>
          <Link href="/inbox" className="text-sm text-accent hover:underline">
            ← Back to inbox
          </Link>
        </div>

        {conversation.highRisk && <HighRiskBanner />}

        <MessageThread messages={messages} canRetry={canSend} />

        <Composer
          conversationId={conversation.id}
          targetLanguage={targetLanguage}
          reviewBeforeSendDefault={false}
          canSend={canSend}
          highRisk={conversation.highRisk}
        />
      </div>

      <div className="flex w-full flex-col gap-4 lg:w-80 lg:flex-shrink-0">
        <AssignmentPanel
          conversationId={conversation.id}
          status={conversation.status}
          highRisk={conversation.highRisk}
          assignedUserId={conversation.assignedUserId}
          assignedTeamId={conversation.assignedTeamId}
          languageOverride={conversation.preferredLanguageOverride}
          users={users.map((u) => ({ id: u.id, name: u.name }))}
          teams={teams.map((t) => ({ id: t.id, name: t.name }))}
          canManage={canAssign}
        />
        <ContactSidebar contact={conversation.contact} canEdit={canSend} />
      </div>
    </div>
  );
}
