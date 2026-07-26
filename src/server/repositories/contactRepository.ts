/**
 * Org-scoped repository for `Contact`, per docs/implementation-plan.md §6.1 (pattern
 * established in organizationRepository.ts/userRepository.ts) and the Phase 5 task brief.
 *
 * Every function takes the caller's `organizationId` explicitly and re-asserts it in the
 * `where` clause. Every function also accepts an optional trailing `client` parameter
 * (defaulting to the module-level `prisma` singleton) so `inboundService`/`outboundService`
 * can thread a `Prisma.TransactionClient` through several repository calls inside one
 * `prisma.$transaction(...)` instead of duplicating query logic per call site.
 */
import { prisma } from "../db";
import type { PrismaClientOrTx } from "../db";
import { NotFoundError } from "../errors";

export interface CreateContactInput {
  displayName: string;
  phoneNumber?: string | null;
  email?: string | null;
  preferredLanguage?: string | null;
  notes?: string | null;
}

export const contactRepository = {
  async findByIdInOrg(organizationId: string, id: string, client: PrismaClientOrTx = prisma) {
    return client.contact.findFirst({ where: { id, organizationId } });
  },

  async findByIdInOrgOrThrow(organizationId: string, id: string, client: PrismaClientOrTx = prisma) {
    const contact = await client.contact.findFirst({ where: { id, organizationId } });
    if (!contact) {
      throw new NotFoundError("Contact not found.", { organizationId, id });
    }
    return contact;
  },

  async listByOrg(
    organizationId: string,
    options: { includeArchived?: boolean } = {},
    client: PrismaClientOrTx = prisma,
  ) {
    return client.contact.findMany({
      where: {
        organizationId,
        ...(options.includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: { displayName: "asc" },
    });
  },

  /**
   * Filtered/searchable listing for the Contacts screen (Phase 7), per
   * docs/implementation-plan.md §5 ("Server Action `listContacts` | List/search/filter
   * contacts | Session | Zod query schema: search, channel, language, archived"). Distinct
   * from `listByOrg` (kept as-is since other callers use its simpler shape) to avoid
   * changing that method's contract.
   */
  async listForContactsPage(
    organizationId: string,
    filters: {
      search?: string;
      channel?: import("@prisma/client").ChannelType;
      language?: string;
      archived?: "active" | "archived" | "all";
    } = {},
    client: PrismaClientOrTx = prisma,
  ) {
    const archived = filters.archived ?? "active";
    return client.contact.findMany({
      where: {
        organizationId,
        ...(archived === "active" ? { archivedAt: null } : archived === "archived" ? { archivedAt: { not: null } } : {}),
        ...(filters.language
          ? { OR: [{ preferredLanguage: filters.language }, { preferredLanguage: null, detectedLanguage: filters.language }] }
          : {}),
        ...(filters.channel ? { identities: { some: { channelAccount: { channelType: filters.channel } } } } : {}),
        ...(filters.search
          ? {
              OR: [
                { displayName: { contains: filters.search, mode: "insensitive" as const } },
                { phoneNumber: { contains: filters.search, mode: "insensitive" as const } },
                { email: { contains: filters.search, mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
      include: {
        identities: { include: { channelAccount: true } },
        _count: { select: { conversations: true } },
      },
      orderBy: { displayName: "asc" },
    });
  },

  async findByIdWithDetails(organizationId: string, id: string, client: PrismaClientOrTx = prisma) {
    const contact = await client.contact.findFirst({
      where: { id, organizationId },
      include: {
        identities: { include: { channelAccount: true } },
        conversations: { orderBy: { lastMessageAt: "desc" }, include: { channelAccount: true } },
      },
    });
    if (!contact) {
      throw new NotFoundError("Contact not found.", { organizationId, id });
    }
    return contact;
  },

  async update(
    organizationId: string,
    id: string,
    input: Partial<{ displayName: string; phoneNumber: string | null; email: string | null; notes: string | null }>,
    client: PrismaClientOrTx = prisma,
  ) {
    const result = await client.contact.updateMany({ where: { id, organizationId }, data: input });
    if (result.count === 0) {
      throw new NotFoundError("Contact not found.", { organizationId, id });
    }
    return contactRepository.findByIdInOrgOrThrow(organizationId, id, client);
  },

  async findByPhoneNumber(organizationId: string, phoneNumber: string, client: PrismaClientOrTx = prisma) {
    return client.contact.findFirst({ where: { organizationId, phoneNumber } });
  },

  async create(organizationId: string, input: CreateContactInput, client: PrismaClientOrTx = prisma) {
    return client.contact.create({
      data: {
        organizationId,
        displayName: input.displayName,
        phoneNumber: input.phoneNumber ?? undefined,
        email: input.email ?? undefined,
        preferredLanguage: input.preferredLanguage ?? undefined,
        notes: input.notes ?? undefined,
      },
    });
  },

  /** Sets `Contact.detectedLanguage` — used by the inbound lifecycle (§3.5 step 6) when `preferredLanguage` is unset. */
  async updateDetectedLanguage(
    organizationId: string,
    id: string,
    detectedLanguage: string,
    client: PrismaClientOrTx = prisma,
  ) {
    const result = await client.contact.updateMany({
      where: { id, organizationId },
      data: { detectedLanguage },
    });
    if (result.count === 0) {
      throw new NotFoundError("Contact not found.", { organizationId, id });
    }
    return contactRepository.findByIdInOrgOrThrow(organizationId, id, client);
  },

  async updatePreferredLanguage(
    organizationId: string,
    id: string,
    preferredLanguage: string,
    client: PrismaClientOrTx = prisma,
  ) {
    const result = await client.contact.updateMany({
      where: { id, organizationId },
      data: { preferredLanguage },
    });
    if (result.count === 0) {
      throw new NotFoundError("Contact not found.", { organizationId, id });
    }
    return contactRepository.findByIdInOrgOrThrow(organizationId, id, client);
  },

  async archive(organizationId: string, id: string, client: PrismaClientOrTx = prisma) {
    const result = await client.contact.updateMany({
      where: { id, organizationId },
      data: { archivedAt: new Date() },
    });
    if (result.count === 0) {
      throw new NotFoundError("Contact not found.", { organizationId, id });
    }
  },
};
