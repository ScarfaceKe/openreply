/**
 * Sumasales patch — POST /internal/campaigns/sync
 *
 * Drop into a fork of diwenne/openreply as:
 *   app/api/internal/campaigns/sync/route.ts
 *
 * Idempotently provisions/updates/deactivates the `[sumasales] …` automation
 * namespace for one Instagram account, without touching any other campaigns.
 * No Prisma migration needed — reuses Automation + TrackedLink.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { z } from "zod";

const CAMPAIGN_SCHEMA = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1),
  dmMessage: z.string().min(1),
  publicReplyEnabled: z.boolean().default(false),
  publicReplyMessage: z.string().default(""),
  linkButtons: z
    .array(z.object({ label: z.string(), url: z.string().url() }))
    .max(2)
    .default([]),
  requireFollow: z.boolean().default(false),
  matchAnyPost: z.boolean().default(true),
});

const SYNC_SCHEMA = z.object({
  workspaceRef: z.string().min(1),
  instagramUsername: z.string().min(1).nullable(),
  active: z.boolean(),
  storeLocked: z.boolean().default(true),
  storeUrl: z.string().url().nullable(),
  campaigns: z.array(CAMPAIGN_SCHEMA),
});

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function POST(request: NextRequest) {
  const secret = process.env.SUMASALES_SYNC_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Sync not configured" }, { status: 503 });
  }
  if (request.headers.get("X-Sync-Secret") !== secret) {
    return unauthorized();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const parsed = SYNC_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const sync = parsed.data;

  // Resolve the workspace + Instagram account. If the handle is unknown we
  // still accept the sync (campaigns live in the workspace, attach later when
  // the account connects) so the flow never dead-ends.
  const workspace = await prisma.workspace.findFirst({
    where: { instagramAccounts: { some: { username: sync.instagramUsername ?? undefined } } },
    include: { instagramAccounts: { where: { username: sync.instagramUsername ?? undefined } } },
  });

  const igAccount = workspace?.instagramAccounts[0] ?? null;

  if (workspace && igAccount) {
    const NAME_PREFIX = "[sumasales] ";
    const existing = await prisma.automation.findMany({
      where: { instagramAccountId: igAccount.id, name: { startsWith: NAME_PREFIX } },
      select: { id: true, name: true, isActive: true },
    });
    const byName = new Map(existing.map((a) => [a.name, a]));
    const incomingNames = new Set(sync.campaigns.map((c) => c.name));

    for (const c of sync.campaigns) {
      const data = {
        workspaceId: workspace.id,
        instagramAccountId: igAccount.id,
        name: c.name,
        keywords: c.keywords,
        dmMessage: c.dmMessage,
        matchAnyPost: c.matchAnyPost,
        wholeWordMatch: false,
        isActive: sync.active,
        publicReplyEnabled: c.publicReplyEnabled,
        publicReplyMessage: c.publicReplyEnabled ? c.publicReplyMessage : null,
        requireFollow: c.requireFollow,
      };
      const current = byName.get(c.name);
      if (current) {
        await prisma.automation.update({ where: { id: current.id }, data });
      } else {
        await prisma.automation.create({ data });
      }

      // Ensure the store link is tracked so clicks show in OpenReply stats.
      if (sync.storeUrl) {
        const linkLabel = "Sumasales store";
        const tracked = await prisma.trackedLink.findFirst({
          where: { automationId: current?.id ?? "", destinationUrl: sync.storeUrl },
        });
        if (!tracked) {
          await prisma.trackedLink.create({
            data: {
              workspaceId: workspace.id,
              automationId: current?.id ?? "",
              slug: `ss-${c.key}-${Date.now().toString(36)}`,
              label: linkLabel,
              destinationUrl: sync.storeUrl,
            },
          });
        }
      }
    }

    // Deactivate stale sumasales campaigns (product removed from selection).
    for (const a of existing) {
      if (!incomingNames.has(a.name) && a.isActive) {
        await prisma.automation.update({ where: { id: a.id }, data: { isActive: false } });
      }
    }
  }

  return NextResponse.json({
    ok: true,
    campaigns: sync.campaigns.length,
    active: sync.active,
    accountResolved: !!igAccount,
  });
}
