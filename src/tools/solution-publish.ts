import { z } from 'zod';
import { SwfteApiError, type SwfteClient } from '../client.js';
import type { ToolDefinition } from './_types.js';

/**
 * Publishing a solution: listing, pricing, visibility, seller payouts.
 *
 * These tools drive the LISTING marketplace (`MarketplaceListing`, listingType
 * SOLUTION) — a different backend domain from the four `swfte_marketplace_*`
 * tools, which point at `/v2/marketplace` root: that is the MODULE marketplace
 * (`ModulePublication`) and cannot see a solution at all. The two share adjacent
 * URL space and nothing else.
 *
 * Where the backend has no field for something, the tool says so in its result
 * rather than dropping the value silently. Four such holes exist today and are
 * named at the tool that would otherwise have set them.
 */

const Workspace = z.object({ workspaceId: z.string().optional() });

/** Publisher-side listing CRUD. Ownership is checked against the caller's account. */
const PUBLISHER = '/v2/marketplace/publisher/listings';
/** The public catalogue. Its whole GET surface is anonymous, so it also works unauthenticated. */
const CATALOGUE = '/v1/marketplace';
/** Stripe Connect, on the module-marketplace controller but scoped to the workspace, not to a module. */
const STRIPE = '/v2/marketplace/stripe';

const listingPath = (id: string) => `${PUBLISHER}/${encodeURIComponent(id)}`;

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Whether a SOLUTION listing can actually be installed, which is not the same
 * question as whether it saved.
 *
 * `MarketplaceInstallService.installSolution` resolves `journeyTemplateId`, then
 * falls back to `sourceId`, and throws when both are null. Nothing on the create
 * or update DTO can set `journeyTemplateId` — only the startup seeder writes it —
 * so `sourceId` is the single carrier available at runtime, and a listing
 * published without one saves, publishes, and then fails on the buyer's install.
 *
 * Mind the asymmetry: the field is `sourceId` on the request DTO and
 * `sourceArtifactId` on the response, mapped from the same column. Reading only
 * `sourceId` off a listing response finds nothing, always.
 */
function installability(listing: Record<string, unknown>): Record<string, unknown> {
  const type = String(listing.listingType ?? '');
  if (type !== 'SOLUTION') return { checked: false, reason: `listingType is ${type || 'unset'}` };
  const template = listing.journeyTemplateId;
  const source = listing.sourceArtifactId ?? listing.sourceId;
  if (typeof template === 'string' && template.length > 0) {
    return { installable: true, deliverable: 'journeyTemplateId', value: template };
  }
  if (typeof source === 'string' && source.length > 0) {
    return {
      installable: true,
      deliverable: 'sourceId (install-time fallback, returned as sourceArtifactId)',
      value: source,
    };
  }
  return {
    installable: false,
    reason: 'NO_DELIVERABLE',
    detail:
      'This SOLUTION listing carries neither journeyTemplateId nor sourceId, so installSolution ' +
      'will throw for every buyer. Set sourceId to the id of a journey template in your workspace.',
  };
}

/** Pull the pricing terms out of a listing, including the two nobody can set at runtime. */
function pricingOf(listing: Record<string, unknown>): Record<string, unknown> {
  return {
    pricingModel: listing.pricingModel ?? null,
    currency: listing.currency ?? null,
    monthlySubscription: listing.monthlySubscription ?? null,
    pricePerUse: listing.pricePerUse ?? null,
    oneTimePrice: listing.oneTimePrice ?? null,
    setupPrice: listing.setupPrice ?? null,
    performanceFeePct: listing.performanceFeePct ?? null,
  };
}

/** Read the publisher's own view of a listing, or null when it is not theirs / not there. */
async function publisherView(
  client: SwfteClient,
  listingId: string,
  workspaceId?: string
): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(
      await client.request({ method: 'GET', path: listingPath(listingId), workspaceId })
    );
  } catch (err) {
    if (err instanceof SwfteApiError && (err.status === 403 || err.status === 404)) return null;
    throw err;
  }
}

export const solutionPublishTools: ToolDefinition[] = [
  // ---------------------------------------------------------------------------
  {
    name: 'swfte_solution_listing_get',
    title: 'Read a solution listing',
    group: 'marketplace',
    readOnly: true,
    description:
      'Read one marketplace listing from both sides: the public catalogue entry a buyer sees, and ' +
      'the publisher record only its owner can read. It also answers the question the payload does ' +
      'not — whether the listing can actually be installed. A SOLUTION listing saves and publishes ' +
      'happily with no deliverable attached and then throws on the first buyer\'s install, so treat ' +
      '`installability.installable:false` as a blocker, not a warning. The eleven listings whose ids ' +
      'begin `solution:` are seeded from JSON at platform startup and carry no publisherAccountId, so ' +
      'the publisher view of one of those is always null and no account can edit them.',
    inputSchema: Workspace.extend({
      listingId: z
        .string()
        .describe('Listing id. Seeded solutions look like "solution:<slug>"; runtime ones are uuids.'),
    }),
    execute: async (input, { client }) => {
      let catalogue: Record<string, unknown> | null = null;
      try {
        catalogue = asRecord(
          await client.request({
            method: 'GET',
            path: `${CATALOGUE}/listings/${encodeURIComponent(input.listingId)}`,
            workspaceId: input.workspaceId,
          })
        );
      } catch (err) {
        if (!(err instanceof SwfteApiError && err.status === 404)) throw err;
      }
      const publisher = await publisherView(client, input.listingId, input.workspaceId);
      const best = publisher ?? catalogue;
      if (!best) {
        return {
          found: false,
          listingId: input.listingId,
          reason: 'NOT_FOUND',
          nextAction:
            'A listing that is not PUBLISHED+PUBLIC is invisible in the catalogue and readable only ' +
            'by its publisher. Check the id with swfte_solution_listing_list.',
        };
      }
      return {
        found: true,
        listingId: input.listingId,
        listingType: best.listingType ?? null,
        status: best.status ?? null,
        visibility: best.visibility ?? null,
        publisherAccountId: publisher ? (publisher.publisherAccountId ?? null) : null,
        seeded: input.listingId.startsWith('solution:'),
        pricing: pricingOf(best),
        installability: installability(best),
        inCatalogue: catalogue !== null,
        ownedByCaller: publisher !== null,
        catalogue,
        publisher,
      };
    },
  },

  // ---------------------------------------------------------------------------
  {
    name: 'swfte_solution_listing_list',
    title: 'List solution listings',
    group: 'marketplace',
    readOnly: true,
    description:
      'List listings, from one of two places. `scope:"mine"` returns the publisher records this ' +
      'account owns, drafts included — the only way to see a listing that is not live yet. ' +
      '`scope:"catalogue"` searches what buyers can see, filtered to listingType SOLUTION unless you ' +
      'widen it. An empty "mine" is the normal state: nothing has ever been published through the ' +
      'runtime publisher path in most workspaces, and the eleven live solutions are seeded rather ' +
      'than owned, so they never appear here.',
    inputSchema: Workspace.extend({
      scope: z
        .enum(['mine', 'catalogue'])
        .default('mine')
        .describe('"mine" = this account\'s publisher records. "catalogue" = the public search.'),
      query: z.string().optional().describe('Free-text search. Catalogue scope only.'),
      category: z.string().optional().describe('Category filter. Catalogue scope only.'),
      listingType: z
        .string()
        .optional()
        .describe('Catalogue scope only. Defaults to SOLUTION; pass e.g. "WORKFLOW" to widen.'),
      page: z.number().int().min(0).optional(),
      size: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (input, { client }) => {
      if (input.scope === 'catalogue') {
        const body = await client.request({
          method: 'GET',
          path: `${CATALOGUE}/search`,
          query: {
            q: input.query,
            category: input.category,
            listingType: input.listingType ?? 'SOLUTION',
            page: input.page,
            size: input.size,
          },
          workspaceId: input.workspaceId,
        });
        return { scope: 'catalogue', listingType: input.listingType ?? 'SOLUTION', result: body };
      }
      const mine = await client.request<unknown>({
        method: 'GET',
        path: PUBLISHER,
        workspaceId: input.workspaceId,
      });
      const rows = Array.isArray(mine) ? mine.map(asRecord) : [];
      return {
        scope: 'mine',
        count: rows.length,
        listings: rows.map((l) => ({
          id: l.id ?? null,
          title: l.title ?? null,
          listingType: l.listingType ?? null,
          status: l.status ?? null,
          visibility: l.visibility ?? null,
          pricing: pricingOf(l),
          installability: installability(l),
        })),
      };
    },
  },

  // ---------------------------------------------------------------------------
  {
    name: 'swfte_solution_publish',
    title: 'Publish a solution to the marketplace',
    group: 'marketplace',
    description:
      'Drive a solution listing through its lifecycle: DRAFT -> submit -> publish, or archive it. ' +
      'DEFAULTS TO DRAFT, which creates a private record and exposes nothing. `action:"publish"` ' +
      'puts the solution in front of buyers and requires confirm:true, as does `archive`. ' +
      'What this cannot do, because no field exists on the backend DTOs: set journeyTemplateId, ' +
      'solutionMetadataJson, setupPrice or performanceFeePct. Only the startup seeder writes those. ' +
      'The deliverable therefore has to travel as `sourceId`, which installSolution reads as its ' +
      'fallback — pass the id of a journey template in your workspace, or the listing will publish ' +
      'and then fail on the buyer\'s install. A multi-artifact solution (workflows + agents + ' +
      'datasets by id) has no journey template and cannot be made installable this way at all; the ' +
      'result says so rather than pretending otherwise.',
    inputSchema: Workspace.extend({
      action: z
        .enum(['draft', 'submit', 'publish', 'archive'])
        .default('draft')
        .describe('Default "draft" — creates the record and exposes nothing.'),
      listingId: z.string().optional().describe('Required for submit, publish and archive.'),
      title: z.string().min(3).max(100).optional().describe('Required for draft. 3-100 characters.'),
      shortDescription: z.string().max(160).optional().describe('Catalogue card copy. Max 160 characters.'),
      longDescription: z.string().optional(),
      category: z.string().optional(),
      tags: z.array(z.string()).optional(),
      sourceId: z
        .string()
        .optional()
        .describe(
          'The journey template this solution installs. The only deliverable carrier available at ' +
            'runtime — installSolution falls back to it when journeyTemplateId is null.'
        ),
      monthlyPrice: z.number().min(0).optional().describe('Recurring monthly fee, in `currency`.'),
      perOutcomePrice: z
        .number()
        .min(0)
        .optional()
        .describe('Charged per successful outcome, metered from the run. In `currency`.'),
      currency: z
        .string()
        .length(3)
        .optional()
        .describe('ISO-4217, e.g. "EUR". Defaults to USD. Authoritative — never inferred from a field name.'),
      confirm: z
        .boolean()
        .optional()
        .describe('Required for action "publish" and "archive". Ignored for draft and submit.'),
    }),
    execute: async (input, { client }) => {
      const action = input.action ?? 'draft';

      if (action === 'draft') {
        if (!input.title) {
          return {
            created: false,
            reason: 'TITLE_REQUIRED',
            nextAction: 'Pass a title of 3-100 characters. The backend rejects anything else with a 400.',
          };
        }
        try {
          const listing = asRecord(
            await client.request({
              method: 'POST',
              path: PUBLISHER,
              body: {
                title: input.title,
                shortDescription: input.shortDescription,
                longDescription: input.longDescription,
                category: input.category,
                tags: input.tags,
                listingType: 'SOLUTION',
                sourceId: input.sourceId,
                pricingModel: 'SUBSCRIPTION',
                monthlySubscription: input.monthlyPrice,
                pricePerUse: input.perOutcomePrice,
                currency: input.currency,
              },
              workspaceId: input.workspaceId,
              retries: 0,
              expectStatuses: [200, 201],
            })
          );
          return {
            created: true,
            listingId: listing.id ?? null,
            status: listing.status ?? null,
            visibility: listing.visibility ?? null,
            pricing: pricingOf(listing),
            installability: installability(listing),
            unsettable: {
              journeyTemplateId: 'no field on CreateListingRequest — seeder-only. Use sourceId.',
              solutionMetadataJson: 'no field on CreateListingRequest.',
              setupPrice: 'no field on either listing DTO; a one-off setup fee cannot be set at runtime.',
              performanceFeePct:
                'no field on either listing DTO — and the platform never charges it in any case, ' +
                'because no commission is observed to take a percentage of.',
            },
            nextAction:
              'Set pricing with swfte_solution_pricing, then action:"publish" with confirm:true. ' +
              'Fix installability first if it reports false.',
            listing,
          };
        } catch (err) {
          if (err instanceof SwfteApiError && err.status === 400) {
            return {
              created: false,
              reason: 'VALIDATION_FAILED',
              detail: err.toJSON(),
              nextAction:
                'Title must be 3-100 characters and shortDescription 160 or fewer. Note there is no ' +
                'SOLUTION case in the backend\'s per-type source validation, so a 400 here is about ' +
                'the copy, not the deliverable.',
            };
          }
          throw err;
        }
      }

      if (!input.listingId) {
        return {
          ok: false,
          reason: 'LISTING_ID_REQUIRED',
          nextAction: `action:"${action}" acts on an existing listing. Find it with swfte_solution_listing_list.`,
        };
      }

      if (action === 'submit') {
        const body = await client.request({
          method: 'POST',
          path: `${listingPath(input.listingId)}/submit`,
          workspaceId: input.workspaceId,
          retries: 0,
          expectStatuses: [200, 202],
        });
        return {
          submitted: true,
          listingId: input.listingId,
          nextAction: 'Submission moves the listing to PENDING_REVIEW. Publish with confirm:true when it passes.',
          result: body,
        };
      }

      if (action === 'archive') {
        if (!input.confirm) {
          return {
            archived: false,
            reason: 'CONFIRMATION_REQUIRED',
            message:
              'Archiving delists the solution. Existing installs are NOT revoked — buyers keep their ' +
              'cloned copies and their subscriptions keep billing. Re-call with confirm:true.',
          };
        }
        const body = await client.request({
          method: 'DELETE',
          path: listingPath(input.listingId),
          workspaceId: input.workspaceId,
          retries: 0,
          expectStatuses: [200, 202, 204],
        });
        return {
          archived: true,
          listingId: input.listingId,
          caveat:
            'Delisted, not revoked. Nothing cascades to MarketplaceInstall rows; existing buyers are unaffected.',
          result: body ?? null,
        };
      }

      // action === 'publish'
      if (!input.confirm) {
        const current = await publisherView(client, input.listingId, input.workspaceId);
        return {
          published: false,
          refused: true,
          reason: 'CONFIRMATION_REQUIRED',
          message:
            'Publishing offers this solution for sale to every workspace and starts the audit ' +
            'pipeline. Review the preview below, then re-call with confirm:true.',
          preview: current
            ? {
                title: current.title ?? null,
                status: current.status ?? null,
                visibility: current.visibility ?? null,
                pricing: pricingOf(current),
                installability: installability(current),
              }
            : { note: 'Listing not readable as publisher — it may be seeded, or owned by another account.' },
        };
      }
      try {
        const listing = asRecord(
          await client.request({
            method: 'POST',
            path: `${listingPath(input.listingId)}/publish`,
            workspaceId: input.workspaceId,
            retries: 0,
            expectStatuses: [200, 202],
          })
        );
        return {
          published: true,
          listingId: input.listingId,
          status: listing.status ?? null,
          visibility: listing.visibility ?? null,
          installability: installability(listing),
          note:
            'Live in the catalogue only when status is PUBLISHED and visibility is PUBLIC — the ' +
            'catalogue read filters on both.',
          listing,
        };
      } catch (err) {
        if (err instanceof SwfteApiError && (err.status === 400 || err.status === 409)) {
          return {
            published: false,
            reason: 'PUBLISH_REJECTED',
            detail: err.toJSON(),
            nextAction:
              'Publishing runs submit-for-review then an automated audit and only then flips to ' +
              'PUBLISHED. A rejection here is the audit, not the request.',
          };
        }
        if (err instanceof SwfteApiError && err.status === 403) {
          return {
            published: false,
            reason: 'NOT_THE_PUBLISHER',
            detail: err.toJSON(),
            nextAction:
              'Ownership is compared against the listing\'s publisherAccountId. Seeded solutions ' +
              '(ids beginning "solution:") have none, so no account can ever publish or edit them.',
          };
        }
        throw err;
      }
    },
  },

  // ---------------------------------------------------------------------------
  {
    name: 'swfte_solution_pricing',
    title: 'Set solution pricing',
    group: 'marketplace',
    description:
      'Set what a solution costs: a recurring monthly fee, a per-outcome fee metered from each ' +
      'successful run, and the currency they are both denominated in. That combination is the one ' +
      'the platform can actually charge end to end — subscribe, meter, gate on install, gate on run, ' +
      'and pause at a spend cap. Repricing a listing that is already PUBLISHED changes what existing ' +
      'buyers are billed, so that case requires confirm:true; pricing a draft does not. ' +
      'Two terms cannot be set here at all, because neither listing DTO carries them: setupPrice (a ' +
      'one-off charged at subscribe) and performanceFeePct (a percentage-of-commission term the ' +
      'platform never charges anyway, since it observes no commission to meter). The result names ' +
      'them rather than dropping them quietly.',
    inputSchema: Workspace.extend({
      listingId: z.string(),
      monthlyPrice: z.number().min(0).optional().describe('Recurring monthly fee, in `currency`.'),
      perOutcomePrice: z.number().min(0).optional().describe('Fee per successful outcome, in `currency`.'),
      oneTimePrice: z
        .number()
        .min(0)
        .optional()
        .describe(
          'Settable, but nothing in the platform charges it — no checkout path reads oneTimePrice. ' +
            'Set it only as a published term you intend to invoice out of band.'
        ),
      currency: z
        .string()
        .length(3)
        .optional()
        .describe('ISO-4217. Authoritative for every amount on the listing.'),
      pricingModel: z
        .enum(['FREE', 'SUBSCRIPTION'])
        .optional()
        .describe('Defaults to leaving it alone. Every live solution listing is SUBSCRIPTION.'),
      confirm: z.boolean().optional().describe('Required when the listing is already PUBLISHED.'),
    }),
    execute: async (input, { client }) => {
      const current = await publisherView(client, input.listingId, input.workspaceId);
      if (!current) {
        return {
          updated: false,
          reason: 'NOT_THE_PUBLISHER',
          nextAction:
            'Only the listing\'s publisher account can reprice it. Seeded solutions carry no ' +
            'publisherAccountId and can never be repriced through this API.',
        };
      }
      const isLive = current.status === 'PUBLISHED';
      if (isLive && !input.confirm) {
        return {
          updated: false,
          refused: true,
          reason: 'CONFIRMATION_REQUIRED',
          message:
            'This listing is PUBLISHED. Changing its price changes what buyers are charged. Review ' +
            'the current terms below, then re-call with confirm:true.',
          currentPricing: pricingOf(current),
          proposed: {
            monthlySubscription: input.monthlyPrice ?? current.monthlySubscription ?? null,
            pricePerUse: input.perOutcomePrice ?? current.pricePerUse ?? null,
            oneTimePrice: input.oneTimePrice ?? current.oneTimePrice ?? null,
            currency: input.currency ?? current.currency ?? null,
            pricingModel: input.pricingModel ?? current.pricingModel ?? null,
          },
        };
      }
      const updated = asRecord(
        await client.request({
          method: 'PUT',
          path: listingPath(input.listingId),
          body: {
            pricingModel: input.pricingModel,
            monthlySubscription: input.monthlyPrice,
            pricePerUse: input.perOutcomePrice,
            oneTimePrice: input.oneTimePrice,
            currency: input.currency,
          },
          workspaceId: input.workspaceId,
          retries: 0,
        })
      );
      return {
        updated: true,
        listingId: input.listingId,
        wasPublished: isLive,
        pricing: pricingOf(updated),
        unsettable: {
          setupPrice:
            'No field on CreateListingRequest or UpdateListingRequest. A one-off setup fee can only ' +
            'reach a listing through the startup seeder.',
          performanceFeePct:
            'Same — and the platform never charges it regardless: it observes no commission to take ' +
            'a percentage of, so it is a published term the publisher invoices out of band.',
        },
        note:
          'perOutcomePrice is charged against the outcome the journey declares at _relay.outcome. A ' +
          'solution that declares none falls back to a derived verdict, so declare it.',
        listing: updated,
      };
    },
  },

  // ---------------------------------------------------------------------------
  {
    name: 'swfte_solution_visibility',
    title: 'Set solution visibility',
    group: 'marketplace',
    description:
      'Move a solution between the three distribution modes: private to one account, internal to ' +
      'the owning organisation, or offered on the marketplace. Two of the three are real. ' +
      '"private" and "marketplace" map onto the listing\'s visibility field, which the catalogue read ' +
      'genuinely filters on. "internal" is REFUSED, not approximated: MarketplaceListing has no ' +
      'direct-share list, so there is no way to expose a listing to named workspaces and nothing ' +
      'short of PUBLIC would be visible to anyone. Publishing to a wider mode never widens access to ' +
      'a solution you already delivered to a customer — a buyer\'s install is a separate copy bound ' +
      'to their own account. Going the other way delists but does not revoke: existing buyers keep ' +
      'their copies and keep being billed.',
    inputSchema: Workspace.extend({
      listingId: z.string(),
      mode: z
        .enum(['private', 'internal', 'marketplace'])
        .describe('"internal" is refused — no backend carrier exists. See the result for what is missing.'),
      confirm: z.boolean().optional().describe('Required for "marketplace", which exposes the listing.'),
    }),
    execute: async (input, { client }) => {
      if (input.mode === 'internal') {
        return {
          changed: false,
          reason: 'NOT_SUPPORTED',
          mode: 'internal',
          missing:
            'MarketplaceListing has no directShares field and the catalogue read filters only on ' +
            'visibility == "PUBLIC", so an internal listing would be visible to nobody rather than to ' +
            'the organisation.',
          precedent:
            'The module marketplace already models this correctly as PublicationVisibility.DIRECT_SHARED ' +
            'with a directShares list enforced at install. Lifting that onto MarketplaceListing is the fix.',
          nextAction:
            'Use "private" and grant access out of band until the listing entity carries a share list. ' +
            'Do not use "marketplace" as a stand-in — it is world-visible.',
        };
      }

      const current = await publisherView(client, input.listingId, input.workspaceId);
      if (!current) {
        return {
          changed: false,
          reason: 'NOT_THE_PUBLISHER',
          nextAction:
            'Only the publisher account can change visibility. Seeded solutions have no publisher account.',
        };
      }

      if (input.mode === 'marketplace' && !input.confirm) {
        return {
          changed: false,
          refused: true,
          reason: 'CONFIRMATION_REQUIRED',
          message:
            'Marketplace visibility offers this solution to every workspace. Re-call with confirm:true.',
          current: {
            status: current.status ?? null,
            visibility: current.visibility ?? null,
            pricing: pricingOf(current),
            installability: installability(current),
          },
        };
      }

      const target = input.mode === 'marketplace' ? 'PUBLIC' : 'PRIVATE';
      const updated = asRecord(
        await client.request({
          method: 'PUT',
          path: listingPath(input.listingId),
          body: { visibility: target },
          workspaceId: input.workspaceId,
          retries: 0,
        })
      );
      const live = updated.status === 'PUBLISHED' && updated.visibility === 'PUBLIC';
      return {
        changed: true,
        listingId: input.listingId,
        mode: input.mode,
        visibility: updated.visibility ?? null,
        status: updated.status ?? null,
        liveInCatalogue: live,
        nextAction:
          input.mode === 'marketplace' && !live
            ? 'Visibility is PUBLIC but the status is not PUBLISHED, so the catalogue still hides it. ' +
              'Run swfte_solution_publish with action:"publish" and confirm:true.'
            : undefined,
        caveat:
          input.mode === 'private'
            ? 'Delisted, not revoked. Existing MarketplaceInstall rows stay active and their ' +
              'subscriptions keep billing — nothing cascades.'
            : undefined,
        listing: updated,
      };
    },
  },

  // ---------------------------------------------------------------------------
  {
    name: 'swfte_solution_seller_account',
    title: 'Seller account and earnings',
    group: 'marketplace',
    description:
      'The seller side of the money: whether this workspace has a Stripe Connect account able to ' +
      'receive charges, what it is earning, and how to start onboarding. `action:"status"` is ' +
      'read-only and is where to start. `action:"onboard"` CREATES A REAL STRIPE EXPRESS ACCOUNT and ' +
      'returns a link the human must open, so it requires confirm:true and both URLs. ' +
      'Two things to know before reading the numbers. The payouts endpoint always returns an empty ' +
      'list — the model, table and read exist but nothing in the platform ever writes a payout row. ' +
      'And solution revenue does not flow through Connect at all today: solutions are billed on the ' +
      'platform rail, so a connected account with a 20% platform fee is the module-marketplace path, ' +
      'not the one an installed solution is charged on.',
    inputSchema: Workspace.extend({
      action: z
        .enum(['status', 'onboard', 'earnings'])
        .default('status')
        .describe('Default "status" — read-only.'),
      returnUrl: z.string().url().optional().describe('Required for onboard. Where Stripe sends the user when done.'),
      refreshUrl: z.string().url().optional().describe('Required for onboard. Where Stripe sends an expired link.'),
      from: z.string().optional().describe('Earnings window start, as the dashboard expects it.'),
      to: z.string().optional().describe('Earnings window end.'),
      confirm: z.boolean().optional().describe('Required for onboard — it creates a real Stripe account.'),
    }),
    execute: async (input, { client }) => {
      const action = input.action ?? 'status';

      if (action === 'onboard') {
        if (!input.confirm) {
          return {
            started: false,
            refused: true,
            reason: 'CONFIRMATION_REQUIRED',
            message:
              'Onboarding creates a real Stripe Express account for this workspace and is not ' +
              'reversible from here. Re-call with confirm:true, returnUrl and refreshUrl.',
          };
        }
        if (!input.returnUrl || !input.refreshUrl) {
          return {
            started: false,
            reason: 'URLS_REQUIRED',
            nextAction: 'Stripe rejects an account link without both returnUrl and refreshUrl; so does the backend.',
          };
        }
        try {
          const body = asRecord(
            await client.request({
              method: 'POST',
              path: `${STRIPE}/onboarding`,
              body: { returnUrl: input.returnUrl, refreshUrl: input.refreshUrl },
              workspaceId: input.workspaceId,
              retries: 0,
              expectStatuses: [200, 201],
            })
          );
          return {
            started: true,
            onboardingUrl: body.onboardingUrl ?? null,
            nextAction:
              'Give the URL to the human — sign-in cannot be automated. Charges only route to the ' +
              'account once its status reaches ACTIVE; poll with action:"status".',
          };
        } catch (err) {
          if (err instanceof SwfteApiError && err.status === 503) {
            return {
              started: false,
              reason: 'STRIPE_NOT_CONFIGURED',
              detail: err.toJSON(),
              nextAction: 'The backend has no Stripe API key set for this environment. This is an operator fix.',
            };
          }
          throw err;
        }
      }

      if (action === 'earnings') {
        const earnings = await client.request({
          method: 'GET',
          path: '/v2/marketplace/publisher/dashboard/earnings',
          query: { from: input.from, to: input.to },
          workspaceId: input.workspaceId,
        });
        return {
          earnings,
          caveat:
            'Publisher-dashboard figures cover listing sales. They are not the same ledger as the ' +
            'solution usage meter, which reports outcomes to the billing service directly.',
        };
      }

      // action === 'status'
      let account: Record<string, unknown> | null = null;
      try {
        account = asRecord(
          await client.request({ method: 'GET', path: `${STRIPE}/account`, workspaceId: input.workspaceId })
        );
      } catch (err) {
        if (!(err instanceof SwfteApiError && err.status === 404)) throw err;
      }
      const subscriptions = await client
        .request<unknown>({ method: 'GET', path: `${STRIPE}/subscriptions`, workspaceId: input.workspaceId })
        .catch(() => null);
      const payouts = await client
        .request<unknown>({ method: 'GET', path: `${STRIPE}/payouts`, workspaceId: input.workspaceId })
        .catch(() => null);
      return {
        connected: account !== null,
        accountStatus: account ? (account.accountStatus ?? null) : null,
        chargesEnabled: account ? (account.chargesEnabled ?? null) : null,
        payoutsEnabled: account ? (account.payoutsEnabled ?? null) : null,
        defaultCurrency: account ? (account.defaultCurrency ?? null) : null,
        subscriptions,
        payouts,
        payoutsCaveat:
          'Always empty. MarketplacePayout has a model, a table and this read, and no code path ' +
          'anywhere writes a row — so an empty list is not evidence that nothing was earned.',
        nextAction: account
          ? undefined
          : 'No connected account for this workspace. Start one with action:"onboard", confirm:true.',
        account,
      };
    },
  },
];
