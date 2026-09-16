/**
 * Sumasales patch — outbound event notifier for the OpenReply fork.
 *
 * Drop into the fork as: lib/sumasales-events.ts
 * Call notifySumasalesDmSent(...) after a successful DM send (worker side),
 * and notifySumasalesPhoneCaptured(...) when an inbound DM parses as a phone
 * number. Events are HMAC-signed and fire-and-forget — OpenReply must never
 * fail a send because Sumasales is unreachable.
 */

import crypto from "node:crypto";

type SumasalesEvent = {
  type: "dm.sent" | "lead.phone_captured" | "comment.received";
  workspaceRef: string | null;
  instagramUsername: string;
  campaignKey?: string;
  campaignName?: string;
  commenterName?: string;
  commenterId?: string;
  productName?: string;
  phone?: string;
  message?: string;
  matchedKeyword?: string;
};

async function postSigned(event: SumasalesEvent): Promise<void> {
  const url = process.env.SUMASALES_WEBHOOK_URL;
  const secret = process.env.SUMASALES_WEBHOOK_SECRET;
  if (!url || !secret) return; // integration disabled — no-op

  try {
    const body = JSON.stringify(event);
    const signature = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OpenReply-Signature": signature,
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch {
    // Never let analytics/lead capture break message delivery.
  }
}

export function notifySumasalesDmSent(input: {
  workspaceRef: string | null;
  instagramUsername: string;
  campaignName: string;
  campaignKey?: string;
  commenterName?: string;
  matchedKeyword?: string;
}): void {
  void postSigned({ type: "dm.sent", ...input });
}

export function notifySumasalesPhoneCaptured(input: {
  workspaceRef: string | null;
  instagramUsername: string;
  campaignName: string;
  campaignKey?: string;
  commenterName?: string;
  phone: string;
  message?: string;
}): void {
  void postSigned({ type: "lead.phone_captured", ...input });
}

/** Extract a Kenyan phone number from an inbound DM text, if present. */
export function extractKenyanPhone(text: string): string | null {
  const match = text.replace(/[()\s-]/g, "").match(/(\+?254|0)(7|1)\d{8}\b/);
  return match ? match[0] : null;
}

/**
 * AI SWEET-TALK PIPELINE (comment.received):
 * forward EVERY interested comment/question to Sumasales. The AI there
 * classifies stage + interest %, crafts the natural reply, and returns it —
 * the fork posts the returned `reply` text back on Instagram and stores the
 * interest metrics with the campaign for the 3-hour reports.
 */
export async function askSumasalesAiReply(input: {
  workspaceRef: string | null;
  instagramUsername: string;
  commenterId: string;
  commenterName?: string;
  message: string;
  campaignName?: string;
  campaignKey?: string;
  productName?: string;
}): Promise<{ reply: string; stage: string; interestScore: number } | null> {
  const url = process.env.SUMASALES_WEBHOOK_URL;
  const secret = process.env.SUMASALES_WEBHOOK_SECRET;
  if (!url || !secret) return null;
  try {
    const body = JSON.stringify({ type: "comment.received", ...input });
    const signature = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);
    const res = await fetch(url.replace(/\/$/, "") + "-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenReply-Signature": signature },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return (await res.json()) as { reply: string; stage: string; interestScore: number };
  } catch {
    return null;
  }
}

/**
 * MANDATORY STORE-LINK LOCK (fork side): when the Sumasales sync says the
 * distributor's store is locked (basic/trial/free), strip every store URL
 * from campaign DMs before sending. Premium-only, enforced at the last
 * possible moment in OpenReply too.
 */
export function scrubStoreUrls(text: string): string {
  return text
    .replace(/https?:\/\/\S*\/store\/[^\s)]*/gi, "")
    .replace(/\n?\s*(🛒\s*)?(Order online|Shop online|Buy online)\s*:?\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
