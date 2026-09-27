// Tiny data-access stub (the real app uses Prisma; the fixture keeps only the shape).
export interface TenantBotRow {
  tenantId: string;
  agentId: string;
  locale: string;
}

const rows: TenantBotRow[] = [];

export const db = {
  tenantBot: {
    async findUnique(where: { tenantId: string }): Promise<TenantBotRow | null> {
      return rows.find((r) => r.tenantId === where.tenantId) ?? null;
    },
  },
};
