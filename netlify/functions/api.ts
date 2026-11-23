import type { Config, Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import {
  handleTermufixApi,
  sha256hex,
  type ClaimRecord,
  type EventRecord,
  type JoinTokenRecord,
  type SessionRecord,
  type TermufixStore,
} from '../../src/termufix-core.ts';

function createNetlifyBlobStore(): TermufixStore {
  const blob = getStore({ name: 'termufix', consistency: 'strong' });

  return {
    async getJoinToken(token: string): Promise<JoinTokenRecord | null> {
      return (await blob.get(`tokens/${token}`, { type: 'json' })) as JoinTokenRecord | null;
    },

    async upsertJoinToken(record: { token: string; label: string; created: number; expires: number }): Promise<void> {
      const existing = (await blob.get(`tokens/${record.token}`, { type: 'json' })) as JoinTokenRecord | null;
      const next: JoinTokenRecord = {
        token: record.token,
        label: record.label,
        created: existing ? existing.created : record.created,
        expires: record.expires,
        enrolls: existing ? existing.enrolls : 0,
      };
      await blob.setJSON(`tokens/${record.token}`, next);
    },

    async incrementJoinTokenEnrolls(token: string): Promise<void> {
      const existing = (await blob.get(`tokens/${token}`, { type: 'json' })) as JoinTokenRecord | null;
      if (!existing) return;
      await blob.setJSON(`tokens/${token}`, { ...existing, enrolls: (existing.enrolls || 0) + 1 });
    },

    async deleteJoinToken(token: string): Promise<void> {
      await blob.delete(`tokens/${token}`);
    },

    async getClaim(claimId: string): Promise<ClaimRecord | null> {
      return (await blob.get(`claims/${claimId}`, { type: 'json' })) as ClaimRecord | null;
    },

    async putClaim(record: ClaimRecord): Promise<void> {
      await blob.setJSON(`claims/${record.claim_id}`, record);
    },

    async getSession(sid: string): Promise<SessionRecord | null> {
      return (await blob.get(`sessions/${sid}`, { type: 'json' })) as SessionRecord | null;
    },

    async putSession(record: SessionRecord): Promise<void> {
      await blob.setJSON(`sessions/${record.sid}`, record, {
        metadata: { created: record.created },
      });
    },

    async listSessions(limit: number): Promise<SessionRecord[]> {
      const { blobs } = await blob.list({ prefix: 'sessions/' });
      const items = await Promise.all(
        blobs.slice(0, Math.max(limit * 2, 100)).map(async (b) => {
          return (await blob.get(b.key, { type: 'json' })) as SessionRecord | null;
        })
      );
      return items
        .filter((s): s is SessionRecord => Boolean(s))
        .sort((a, b) => Number(b.created) - Number(a.created))
        .slice(0, limit);
    },

    async appendEvent(event: EventRecord): Promise<void> {
      try {
        const rand = Math.random().toString(16).slice(2, 8);
        await blob.setJSON(`events/${event.sid}/${event.ts}-${rand}`, event);
      } catch {
        // logging is best-effort
      }
    },

    async countRecentStarts(ip: string, sinceTs: number): Promise<number> {
      const ipKey = await sha256hex(ip);
      const data = (await blob.get(`starts/${ipKey}`, { type: 'json' })) as { timestamps?: number[] } | null;
      const list = Array.isArray(data?.timestamps) ? data.timestamps : [];
      return list.filter((ts) => ts > sinceTs).length;
    },

    async recordStart(ip: string, ts: number): Promise<void> {
      const ipKey = await sha256hex(ip);
      const data = (await blob.get(`starts/${ipKey}`, { type: 'json' })) as { timestamps?: number[] } | null;
      const cutoff = ts - 3600;
      const list = (Array.isArray(data?.timestamps) ? data.timestamps : []).filter((t) => t > cutoff);
      list.push(ts);
      await blob.setJSON(`starts/${ipKey}`, { timestamps: list });
    },
  };
}

export default async (req: Request, context: Context): Promise<Response> => {
  try {
    const store = createNetlifyBlobStore();
    const adminToken =
      (typeof Netlify !== 'undefined' && Netlify.env ? Netlify.env.get('ADMIN_TOKEN') : undefined) ||
      process.env.ADMIN_TOKEN ||
      '';
    const clientIp =
      context.ip ||
      req.headers.get('x-nf-client-connection-ip') ||
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      'unknown';
    return await handleTermufixApi(req, { store, adminToken, clientIp });
  } catch (err) {
    console.error(err);
    return new Response('internal error\n', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
};

export const config: Config = {
  path: ['/health', '/join/*', '/api/*', '/s/*', '/admin/*'],
};
