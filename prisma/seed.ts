/**
 * Dev seed script, per docs/implementation-plan.md §4 ("Dev seed") and Phase 3 deliverables.
 *
 * Creates:
 *  - One Organization ("Acme Demo Co", defaultLanguage "en")
 *  - Five Users, one per Role, all sharing one known dev password (hashed with bcrypt)
 *  - One Team with mixed membership (a LEAD and MEMBERs)
 *  - Three ChannelAccounts: Telegram (ACTIVE), Android SMS (ACTIVE), WhatsApp (PENDING_SETUP,
 *    since WHATSAPP_ENABLED defaults to false)
 *  - Eight Contacts with varied preferredLanguage (some resolved only via detectedLanguage)
 *  - Conversations with realistic message history, including at least one FAILED and one
 *    DEAD_LETTER message so the retry UI (built in a later phase) has something to show.
 *
 * Run with `npm run db:seed`. Prints login credentials to the console on completion.
 */
import { createHash } from "node:crypto";
import {
  PrismaClient,
  Role,
  TeamRole,
  ChannelType,
  ChannelAccountStatus,
  ConversationStatus,
  SenderType,
  MessageDirection,
  MessageStatus,
} from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const DEV_PASSWORD = "DevPassword123!";

function inboundIdempotencyKey(channelAccountId: string, externalMessageId: string): string {
  return createHash("sha256").update(`${channelAccountId}:${externalMessageId}`).digest("hex");
}

function outboundIdempotencyKey(seed: string): string {
  return createHash("sha256").update(`outbound:${seed}`).digest("hex");
}

async function main() {
  console.log("Seeding database…");

  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);

  // ---------- Organization ----------
  const org = await prisma.organization.create({
    data: {
      name: "Acme Demo Co",
      defaultLanguage: "en",
      timezone: "UTC",
    },
  });

  // ---------- Users (one per role) ----------
  const [owner, administrator, manager, agent, viewer] = await Promise.all([
    prisma.user.create({
      data: {
        organizationId: org.id,
        name: "Olivia Owner",
        email: "owner@acme-demo.test",
        role: Role.OWNER,
        preferredLanguage: "en",
        passwordHash,
        emailVerified: new Date(),
      },
    }),
    prisma.user.create({
      data: {
        organizationId: org.id,
        name: "Adrian Administrator",
        email: "admin@acme-demo.test",
        role: Role.ADMINISTRATOR,
        preferredLanguage: "en",
        passwordHash,
        emailVerified: new Date(),
      },
    }),
    prisma.user.create({
      data: {
        organizationId: org.id,
        name: "Marta Manager",
        email: "manager@acme-demo.test",
        role: Role.MANAGER,
        preferredLanguage: "es",
        passwordHash,
        emailVerified: new Date(),
      },
    }),
    prisma.user.create({
      data: {
        organizationId: org.id,
        name: "Alex Agent",
        email: "agent@acme-demo.test",
        role: Role.AGENT,
        preferredLanguage: "fr",
        passwordHash,
        emailVerified: new Date(),
      },
    }),
    prisma.user.create({
      data: {
        organizationId: org.id,
        name: "Vic Viewer",
        email: "viewer@acme-demo.test",
        role: Role.VIEWER,
        preferredLanguage: "en",
        passwordHash,
        emailVerified: new Date(),
      },
    }),
  ]);

  // ---------- Team ----------
  const team = await prisma.team.create({
    data: {
      organizationId: org.id,
      name: "Support Team",
      members: {
        create: [
          { userId: owner.id, role: TeamRole.LEAD },
          { userId: manager.id, role: TeamRole.MEMBER },
          { userId: agent.id, role: TeamRole.MEMBER },
        ],
      },
    },
  });

  // ---------- Channel accounts ----------
  const telegramAccount = await prisma.channelAccount.create({
    data: {
      organizationId: org.id,
      channelType: ChannelType.TELEGRAM,
      displayName: "Acme Support Bot",
      externalAccountId: "acme_support_bot",
      credentialRef: "dev-placeholder-telegram-credential",
      status: ChannelAccountStatus.ACTIVE,
    },
  });

  const androidAccount = await prisma.channelAccount.create({
    data: {
      organizationId: org.id,
      channelType: ChannelType.ANDROID_SMS,
      displayName: "Front Desk Phone",
      externalAccountId: "android-device-001",
      credentialRef: "dev-placeholder-android-device-token",
      status: ChannelAccountStatus.ACTIVE,
    },
  });

  const whatsappAccount = await prisma.channelAccount.create({
    data: {
      organizationId: org.id,
      channelType: ChannelType.WHATSAPP,
      displayName: "Acme WhatsApp (not yet configured)",
      status: ChannelAccountStatus.PENDING_SETUP,
    },
  });

  // ---------- Contacts (varied preferredLanguage) ----------
  const maria = await prisma.contact.create({
    data: {
      organizationId: org.id,
      displayName: "Maria Garcia",
      preferredLanguage: "es",
      phoneNumber: "+34600111222",
    },
  });
  const jean = await prisma.contact.create({
    data: {
      organizationId: org.id,
      displayName: "Jean Dupont",
      preferredLanguage: "fr",
      phoneNumber: "+33612345678",
    },
  });
  const anna = await prisma.contact.create({
    data: {
      organizationId: org.id,
      displayName: "Anna Kowalski",
      preferredLanguage: "pl",
      phoneNumber: "+48123456789",
    },
  });
  const hiroshi = await prisma.contact.create({
    data: {
      organizationId: org.id,
      displayName: "Hiroshi Tanaka",
      preferredLanguage: "ja",
      phoneNumber: "+81312345678",
    },
  });
  const ahmed = await prisma.contact.create({
    data: {
      organizationId: org.id,
      displayName: "Ahmed Hassan",
      preferredLanguage: "ar",
      phoneNumber: "+201001234567",
    },
  });
  const john = await prisma.contact.create({
    data: {
      organizationId: org.id,
      displayName: "John Smith",
      // preferredLanguage intentionally unset — resolution should fall back to
      // detectedLanguage per docs/implementation-plan.md §3.4.
      detectedLanguage: "en",
      phoneNumber: "+14155552671",
    },
  });
  const liWei = await prisma.contact.create({
    data: {
      organizationId: org.id,
      displayName: "Li Wei",
      preferredLanguage: "zh",
      phoneNumber: "+8613800138000",
    },
  });
  const sofia = await prisma.contact.create({
    data: {
      organizationId: org.id,
      displayName: "Sofia Rossi",
      preferredLanguage: "it",
      phoneNumber: "+393331234567",
    },
  });

  // ---------- Contact channel identities ----------
  await prisma.contactChannelIdentity.createMany({
    data: [
      {
        contactId: maria.id,
        channelAccountId: telegramAccount.id,
        externalContactId: "tg-100234",
        externalUsername: "maria_g",
      },
      {
        contactId: jean.id,
        channelAccountId: telegramAccount.id,
        externalContactId: "tg-100235",
        externalUsername: "jean_dupont",
      },
      {
        contactId: anna.id,
        channelAccountId: telegramAccount.id,
        externalContactId: "tg-100236",
        externalUsername: "anna_k",
      },
      {
        contactId: hiroshi.id,
        channelAccountId: androidAccount.id,
        externalContactId: "+81312345678",
        phoneNumber: "+81312345678",
      },
      {
        contactId: ahmed.id,
        channelAccountId: androidAccount.id,
        externalContactId: "+201001234567",
        phoneNumber: "+201001234567",
      },
      {
        contactId: john.id,
        channelAccountId: androidAccount.id,
        externalContactId: "+14155552671",
        phoneNumber: "+14155552671",
      },
      // Registered against WhatsApp (PENDING_SETUP) — no conversation yet since the
      // channel isn't active; demonstrates a contact identity that's ready to go live
      // once WHATSAPP_ENABLED is turned on and the account is connected.
      {
        contactId: liWei.id,
        channelAccountId: whatsappAccount.id,
        externalContactId: "wa-861380013800",
        phoneNumber: "+8613800138000",
      },
      {
        contactId: sofia.id,
        channelAccountId: whatsappAccount.id,
        externalContactId: "wa-393331234567",
        phoneNumber: "+393331234567",
      },
    ],
  });

  // ---------- Conversations + messages ----------

  // Helper to bump lastMessageAt after inserting messages.
  async function touchConversation(conversationId: string, lastMessageAt: Date) {
    await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt } });
  }

  // 1) Maria Garcia (Telegram, Spanish) — open, assigned to Alex Agent, healthy back-and-forth.
  const mariaConversation = await prisma.conversation.create({
    data: {
      organizationId: org.id,
      contactId: maria.id,
      channelAccountId: telegramAccount.id,
      assignedUserId: agent.id,
      assignedTeamId: team.id,
      status: ConversationStatus.OPEN,
    },
  });
  const mariaT0 = new Date("2026-07-20T09:00:00Z");
  await prisma.message.create({
    data: {
      organizationId: org.id,
      conversationId: mariaConversation.id,
      senderType: SenderType.CONTACT,
      direction: MessageDirection.INBOUND,
      originalText: "Hola, necesito ayuda con mi pedido #4821.",
      translatedText: "Hi, I need help with my order #4821.",
      sourceLanguage: "es",
      targetLanguage: "fr",
      translationProvider: "noop",
      translationConfidence: 0,
      channelType: ChannelType.TELEGRAM,
      externalMessageId: "tg-msg-1001",
      status: MessageStatus.DELIVERED,
      idempotencyKey: inboundIdempotencyKey(telegramAccount.id, "tg-msg-1001"),
      createdAt: mariaT0,
    },
  });
  const mariaT1 = new Date("2026-07-20T09:02:00Z");
  await prisma.message.create({
    data: {
      organizationId: org.id,
      conversationId: mariaConversation.id,
      senderType: SenderType.USER,
      direction: MessageDirection.OUTBOUND,
      originalText: "Bonjour Maria, je regarde votre commande tout de suite.",
      translatedText: "Hola Maria, estoy revisando tu pedido ahora mismo.",
      sourceLanguage: "fr",
      targetLanguage: "es",
      translationProvider: "noop",
      translationConfidence: 0,
      channelType: ChannelType.TELEGRAM,
      externalMessageId: "tg-msg-1002",
      status: MessageStatus.SENT,
      idempotencyKey: outboundIdempotencyKey("maria-outbound-1"),
      createdAt: mariaT1,
    },
  });
  await touchConversation(mariaConversation.id, mariaT1);

  // 2) Jean Dupont (Telegram, French) — pending, unassigned.
  const jeanConversation = await prisma.conversation.create({
    data: {
      organizationId: org.id,
      contactId: jean.id,
      channelAccountId: telegramAccount.id,
      status: ConversationStatus.PENDING,
    },
  });
  const jeanT0 = new Date("2026-07-22T14:30:00Z");
  await prisma.message.create({
    data: {
      organizationId: org.id,
      conversationId: jeanConversation.id,
      senderType: SenderType.CONTACT,
      direction: MessageDirection.INBOUND,
      originalText: "Quels sont vos horaires d'ouverture ?",
      translatedText: "What are your opening hours?",
      sourceLanguage: "fr",
      targetLanguage: "en",
      translationProvider: "noop",
      translationConfidence: 0,
      channelType: ChannelType.TELEGRAM,
      externalMessageId: "tg-msg-2001",
      status: MessageStatus.DELIVERED,
      idempotencyKey: inboundIdempotencyKey(telegramAccount.id, "tg-msg-2001"),
      createdAt: jeanT0,
    },
  });
  await touchConversation(jeanConversation.id, jeanT0);

  // 3) Anna Kowalski (Telegram, Polish) — resolved.
  const annaConversation = await prisma.conversation.create({
    data: {
      organizationId: org.id,
      contactId: anna.id,
      channelAccountId: telegramAccount.id,
      assignedUserId: manager.id,
      status: ConversationStatus.RESOLVED,
    },
  });
  const annaT0 = new Date("2026-07-18T11:00:00Z");
  const annaT1 = new Date("2026-07-18T11:10:00Z");
  await prisma.message.create({
    data: {
      organizationId: org.id,
      conversationId: annaConversation.id,
      senderType: SenderType.CONTACT,
      direction: MessageDirection.INBOUND,
      originalText: "Dziękuję za szybką pomoc!",
      translatedText: "Thanks for the quick help!",
      sourceLanguage: "pl",
      targetLanguage: "es",
      translationProvider: "noop",
      translationConfidence: 0,
      channelType: ChannelType.TELEGRAM,
      externalMessageId: "tg-msg-3001",
      status: MessageStatus.DELIVERED,
      idempotencyKey: inboundIdempotencyKey(telegramAccount.id, "tg-msg-3001"),
      createdAt: annaT0,
    },
  });
  await prisma.message.create({
    data: {
      organizationId: org.id,
      conversationId: annaConversation.id,
      senderType: SenderType.USER,
      direction: MessageDirection.OUTBOUND,
      originalText: "De nada, ¡que tengas un buen día!",
      translatedText: "Nie ma za co, miłego dnia!",
      sourceLanguage: "es",
      targetLanguage: "pl",
      translationProvider: "noop",
      translationConfidence: 0,
      channelType: ChannelType.TELEGRAM,
      externalMessageId: "tg-msg-3002",
      status: MessageStatus.READ,
      idempotencyKey: outboundIdempotencyKey("anna-outbound-1"),
      createdAt: annaT1,
    },
  });
  await touchConversation(annaConversation.id, annaT1);

  // 4) Hiroshi Tanaka (Android SMS, Japanese) — open, includes a FAILED outbound message.
  const hiroshiConversation = await prisma.conversation.create({
    data: {
      organizationId: org.id,
      contactId: hiroshi.id,
      channelAccountId: androidAccount.id,
      assignedUserId: agent.id,
      status: ConversationStatus.OPEN,
    },
  });
  const hiroshiT0 = new Date("2026-07-24T08:00:00Z");
  await prisma.message.create({
    data: {
      organizationId: org.id,
      conversationId: hiroshiConversation.id,
      senderType: SenderType.CONTACT,
      direction: MessageDirection.INBOUND,
      originalText: "配送はいつ届きますか？",
      translatedText: "When will the delivery arrive?",
      sourceLanguage: "ja",
      targetLanguage: "fr",
      translationProvider: "noop",
      translationConfidence: 0,
      channelType: ChannelType.ANDROID_SMS,
      externalMessageId: "sms-4001",
      status: MessageStatus.DELIVERED,
      idempotencyKey: inboundIdempotencyKey(androidAccount.id, "sms-4001"),
      createdAt: hiroshiT0,
    },
  });
  const hiroshiT1 = new Date("2026-07-24T08:05:00Z");
  const hiroshiFailedMessage = await prisma.message.create({
    data: {
      organizationId: org.id,
      conversationId: hiroshiConversation.id,
      senderType: SenderType.USER,
      direction: MessageDirection.OUTBOUND,
      originalText: "Votre colis arrivera demain avant midi.",
      translatedText: "荷物は明日の正午前に届きます。",
      sourceLanguage: "fr",
      targetLanguage: "ja",
      translationProvider: "noop",
      translationConfidence: 0,
      channelType: ChannelType.ANDROID_SMS,
      status: MessageStatus.FAILED,
      failureReason: "Android gateway device was offline (heartbeat timeout).",
      idempotencyKey: outboundIdempotencyKey("hiroshi-outbound-1"),
      createdAt: hiroshiT1,
    },
  });
  await prisma.messageEvent.createMany({
    data: [
      { messageId: hiroshiFailedMessage.id, eventType: "retry_scheduled", createdAt: hiroshiT1 },
      {
        messageId: hiroshiFailedMessage.id,
        eventType: "failed",
        payload: { reason: "device_offline" },
        createdAt: new Date("2026-07-24T08:10:00Z"),
      },
    ],
  });
  await touchConversation(hiroshiConversation.id, hiroshiT1);

  // 5) Ahmed Hassan (Android SMS, Arabic) — pending, healthy exchange.
  const ahmedConversation = await prisma.conversation.create({
    data: {
      organizationId: org.id,
      contactId: ahmed.id,
      channelAccountId: androidAccount.id,
      status: ConversationStatus.PENDING,
    },
  });
  const ahmedT0 = new Date("2026-07-25T16:00:00Z");
  await prisma.message.create({
    data: {
      organizationId: org.id,
      conversationId: ahmedConversation.id,
      senderType: SenderType.CONTACT,
      direction: MessageDirection.INBOUND,
      originalText: "هل يمكنني تغيير عنوان الشحن؟",
      translatedText: "Can I change the shipping address?",
      sourceLanguage: "ar",
      targetLanguage: "en",
      translationProvider: "noop",
      translationConfidence: 0,
      channelType: ChannelType.ANDROID_SMS,
      externalMessageId: "sms-5001",
      status: MessageStatus.DELIVERED,
      idempotencyKey: inboundIdempotencyKey(androidAccount.id, "sms-5001"),
      createdAt: ahmedT0,
    },
  });
  await touchConversation(ahmedConversation.id, ahmedT0);

  // 6) John Smith (Android SMS, English via detectedLanguage) — open, includes a
  // DEAD_LETTER outbound message (exhausted retries).
  const johnConversation = await prisma.conversation.create({
    data: {
      organizationId: org.id,
      contactId: john.id,
      channelAccountId: androidAccount.id,
      assignedUserId: agent.id,
      status: ConversationStatus.OPEN,
    },
  });
  const johnT0 = new Date("2026-07-23T10:00:00Z");
  await prisma.message.create({
    data: {
      organizationId: org.id,
      conversationId: johnConversation.id,
      senderType: SenderType.CONTACT,
      direction: MessageDirection.INBOUND,
      originalText: "Is there a way to get a refund on my last order?",
      translatedText: "Is there a way to get a refund on my last order?",
      sourceLanguage: "en",
      targetLanguage: "fr",
      translationProvider: "noop",
      translationConfidence: 0,
      channelType: ChannelType.ANDROID_SMS,
      externalMessageId: "sms-6001",
      status: MessageStatus.DELIVERED,
      idempotencyKey: inboundIdempotencyKey(androidAccount.id, "sms-6001"),
      createdAt: johnT0,
    },
  });
  const johnT1 = new Date("2026-07-23T10:15:00Z");
  const johnDeadLetterMessage = await prisma.message.create({
    data: {
      organizationId: org.id,
      conversationId: johnConversation.id,
      senderType: SenderType.USER,
      direction: MessageDirection.OUTBOUND,
      originalText: "Oui, je peux traiter un remboursement complet aujourd'hui.",
      translatedText: "Yes, I can process a full refund today.",
      sourceLanguage: "fr",
      targetLanguage: "en",
      translationProvider: "noop",
      translationConfidence: 0,
      channelType: ChannelType.ANDROID_SMS,
      status: MessageStatus.DEAD_LETTER,
      failureReason: "Exceeded maximum retry attempts (5) — device never came back online.",
      idempotencyKey: outboundIdempotencyKey("john-outbound-1"),
      createdAt: johnT1,
    },
  });
  await prisma.messageEvent.createMany({
    data: [
      {
        messageId: johnDeadLetterMessage.id,
        eventType: "retry_scheduled",
        payload: { attempt: 1 },
        createdAt: new Date("2026-07-23T10:16:00Z"),
      },
      {
        messageId: johnDeadLetterMessage.id,
        eventType: "retry_scheduled",
        payload: { attempt: 2 },
        createdAt: new Date("2026-07-23T10:20:00Z"),
      },
      {
        messageId: johnDeadLetterMessage.id,
        eventType: "failed",
        payload: { reason: "max_retries_exceeded" },
        createdAt: new Date("2026-07-23T10:30:00Z"),
      },
    ],
  });
  await touchConversation(johnConversation.id, johnT1);

  console.log("Seed complete.\n");
  console.log("Seeded organization:", org.name);
  console.log("Seeded users (all share the same dev password):");
  console.log(`  Password for every seeded user: ${DEV_PASSWORD}\n`);
  for (const user of [owner, administrator, manager, agent, viewer]) {
    console.log(`  ${user.role.padEnd(14)} ${user.email}`);
  }
  console.log("\nSign in at /sign-in with any of the emails above and the password shown.");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
