# Shopify ↔ NetSuite Bridge

> Open-source middleware scaffolding for syncing orders, inventory, and fulfillment between Shopify and Oracle NetSuite, built and maintained by [Avalux](https://avalux.io). Part of the [Avalux open-source toolkit](https://github.com/avalux-io/avalux-open-source).

## Why this exists

Growth-stage e-commerce brands hit a predictable wall around the time monthly order volume crosses 5,000. Shopify is excellent at the front of house. NetSuite is the system of record for finance, inventory, and (often) procurement. The space between them is where things break: orders posted under the wrong subsidiary, inventory levels drifting by hundreds of units a day, shipping income mapped to revenue accounts that distort the P&L, returns that close in Shopify but never settle in the general ledger.

Most integration vendors solve the easy 80% and charge per-order fees. The remaining 20% is where the actual accounting lives: multi-currency exchange-rate locking, deferred revenue handling for pre-orders, refund-to-credit-memo reconciliation, item fulfillment split across multiple NetSuite Locations from a single Shopify basket, and tax decomposition that survives a SOX audit.

This repository is the scaffolding we use when we onboard a new client into a Shopify-to-NetSuite engagement. It is not a productized SaaS. It is an opinionated codebase you can fork, harden, and host yourself.

## Who this is for

This codebase is aimed at:

- Heads of e-commerce or finance ops at brands doing $5M to $200M GMV on Shopify, running NetSuite as the financial system of record
- Internal engineering teams who have been quoted $80k to $250k by an integration vendor and want to understand what they would be paying for
- Solutions architects evaluating build vs. buy on the Shopify-NetSuite interface
- 3PL operators who need a clean middleware layer between merchant Shopify stores and a shared NetSuite tenant

If you are running fewer than 500 orders a month, you do not need this. Use a packaged connector. The economics only flip in your favor once the volume justifies the engineering investment.

## This is scaffolding, not a finished product

We need to say this loudly because the open-source label gets misread. What is in this repository:

- Working type definitions for Shopify Order, NetSuite SalesOrder, and the canonical mapping between them
- A reference webhook receiver that verifies Shopify HMACs and queues orders for downstream processing
- A NetSuite REST client stub configured for Token Based Authentication (TBA) and OAuth 2.0 machine-to-machine
- Example chart-of-accounts and location-map JSON files showing the shape of the mapping configuration
- Documentation for the NetSuite setup steps (RESTlets, custom fields, integration record, role permissions) that you cannot skip

What is not in this repository:

- Your specific account numbers, subsidiary IDs, internal IDs, tax codes, or customer mappings
- A production-grade queue (we sketch the interface, you bring SQS, Cloud Tasks, Redis Streams, or whatever you already run)
- Retry, dead-letter, and idempotency logic hardened for your throughput
- Monitoring, alerting, and reconciliation dashboards
- The integration record, role, employee, and saved searches inside your NetSuite tenant

Standing up the real system on top of this scaffold is a multi-week engagement for a competent senior engineer who has touched both APIs before. We do this work professionally at [avalux.io](https://avalux.io). The code here is what we would build for you, minus the bits that are unique to your accounting policy.

## What's in the box

```
shopify-netsuite-bridge/
├── README.md
├── LICENSE
├── .env.example
├── package.json
├── src/
│   ├── index.ts                          # Express webhook receiver
│   ├── shopify/
│   │   ├── webhookVerify.ts              # HMAC SHA-256 verification
│   │   ├── client.ts                     # GraphQL Admin client
│   │   └── inventoryLevels.ts            # inventory level mutations
│   ├── netsuite/
│   │   ├── client.ts                     # TBA + OAuth 2.0 REST client
│   │   ├── salesOrder.ts                 # SO create / update / cancel
│   │   ├── itemFulfillment.ts            # fulfillment record creation
│   │   ├── creditMemo.ts                 # refunds and returns
│   │   └── customer.ts                   # customer upsert
│   ├── mappers/
│   │   ├── orderToSalesOrder.ts          # the core mapping function
│   │   ├── fulfillmentToFulfillment.ts
│   │   └── refundToCreditMemo.ts
│   ├── config/
│   │   ├── accountMap.ts                 # chart-of-accounts mapping
│   │   ├── locationMap.ts                # warehouse routing
│   │   └── taxCodeMap.ts                 # tax decomposition
│   └── queue/
│       └── orderQueue.ts                 # queue interface (BYO backend)
├── examples/
│   ├── chart-of-accounts.example.json
│   ├── location-map.example.json
│   └── tax-mapping.example.json
└── docs/
    ├── ARCHITECTURE.md
    ├── NETSUITE_SETUP.md
    └── SHOPIFY_SETUP.md
```

## Quick start

```bash
git clone https://github.com/avalux-io/shopify-netsuite-bridge.git
cd shopify-netsuite-bridge
cp .env.example .env
npm install
npm run typecheck
npm run dev
```

Point a Shopify webhook at `https://your-host/webhooks/shopify/orders/paid` with topic `orders/paid`. The receiver verifies the HMAC, enqueues the payload, and the worker maps the order into a NetSuite Sales Order using the configuration in `src/config/`.

To run against a NetSuite sandbox, generate a TBA token under Setup → Users/Roles → Access Tokens, drop the four credentials into `.env`, and confirm the integration record has the correct permissions. The `docs/NETSUITE_SETUP.md` file walks the setup end to end.

## How the order sync works

Shopify fires `orders/create`, `orders/updated`, `orders/cancelled`, and `orders/paid` webhooks. Naively, you would create a NetSuite Sales Order on `orders/create` and call it done. In practice that breaks for three reasons:

1. **`orders/create` fires before payment authorizes.** Card declines mean you create a SO, then have to cancel it. NetSuite cancellation audits are noisy. We default to listening on `orders/paid` for the SO trigger, and on `orders/create` only for fraud-screened pre-orders.
2. **Tax lines on the Shopify payload do not decompose cleanly to NetSuite tax codes.** A single line item can have multiple `tax_lines` entries (state, county, city, district). NetSuite expects a single `taxCode` per line. The `config/taxCodeMap.ts` file is where you reconcile that, usually by jurisdiction-rate fingerprinting.
3. **Multi-currency orders need an exchange rate locked at order time, not at sync time.** If Shopify processed the order at GBP 1.27 and we sync four hours later at GBP 1.265, your revenue and your gateway settlement drift. We pass an `fxRateProvider` into the mapper and recommend pinning the rate from the Shopify `presentment_money` block on the order payload itself.

## Chart of accounts mapping

The single most-asked question in any Shopify-NetSuite engagement is: which NetSuite GL account does X land in? The default mapping shipped in `examples/chart-of-accounts.example.json` looks like this:

```json
{
  "revenue": {
    "default": "40010 Product Revenue Online",
    "by_collection": {
      "gid://shopify/Collection/123": "40020 Product Revenue Online (Subscription)",
      "gid://shopify/Collection/456": "40030 Product Revenue Online (Wholesale)"
    }
  },
  "shipping_income": "40050 Shipping Income",
  "discount_contra": "40090 Discounts and Promotions",
  "gift_card_liability": "21010 Gift Card Liability",
  "merchant_fees": "60110 Merchant Processing Fees",
  "sales_tax_payable": "21500 Sales Tax Payable",
  "deferred_revenue": "21200 Deferred Revenue"
}
```

The mapper resolves an account per line item by checking item-level mapping first, then collection membership, then falling back to the default. Shipping is split out so your DTC margin is calculable. Discounts post as a contra-revenue account so net revenue is correct without distorting gross. Gift cards land on the liability side until redemption, not as revenue at sale.

If you are using NetSuite Classes or Departments to slice revenue by channel, set them in `src/config/accountMap.ts`. The mapper threads them through to the Sales Order header and each line.

## Multi-warehouse and fulfillment routing

NetSuite Locations are the source of truth for inventory. Shopify Locations are the source of truth for fulfillment decisions. They need to stay in lockstep.

The `locationMap.ts` config defines the bidirectional mapping:

```typescript
export const locationMap = {
  shopifyToNetsuite: {
    "gid://shopify/Location/72112": { internalId: 4, name: "Reno DC" },
    "gid://shopify/Location/72113": { internalId: 7, name: "Atlanta DC" },
    "gid://shopify/Location/72114": { internalId: 11, name: "Brampton DC" }
  },
  routing: {
    strategy: "zone-priority",
    zones: [
      { regex: "^(CA|OR|WA|NV|AZ)$", primary: 4, secondary: 7 },
      { regex: "^(NY|NJ|PA|FL|GA)$", primary: 7, secondary: 4 }
    ],
    fallback: 4
  }
};
```

On `orders/paid`, we infer the intended fulfillment Location from the shipping address (US state, Canadian province, or country fallback), check NetSuite item availability at the primary, fall back to secondary if backorder, and split the Sales Order across Locations when a single basket cannot ship from one site. Splits get tagged with `custbody_split_parent_id` so reconciliation downstream can group them back together.

Inventory levels flow the other direction. A NetSuite saved search emits item-location quantity snapshots every N minutes. The `inventoryLevels.ts` module debounces and pushes to Shopify via the GraphQL `inventoryAdjustQuantities` mutation. We push deltas, not absolutes, to avoid race conditions with simultaneous Shopify-side adjustments from staff during in-store pick-pack.

## NetSuite auth

The client supports both TBA (the older HMAC-SHA256 signature scheme) and OAuth 2.0 (machine-to-machine with JWT bearer flow). New tenants should use OAuth 2.0. Legacy tenants that have not enabled OAuth 2.0 still need TBA. The `src/netsuite/client.ts` module routes based on which env vars are populated.

For OAuth 2.0, you need:

- The integration record certificate ID
- The PEM-encoded private key (mounted as a secret, not committed)
- The NetSuite account ID and the service account user

For TBA, you need the four-tuple (account ID, consumer key, consumer secret, token ID, token secret). Token Based Authentication signs every request with the order-correct OAuth 1.0a header. The signing implementation in this repo follows the NetSuite spec, including the alphabetical parameter ordering that bites people the first time.

## Why we built this

Avalux runs custom automation engagements for SMB and growth-stage e-commerce operators. Every NetSuite-Shopify project we have shipped starts with the same scaffolding, and we got tired of rebuilding it from scratch on day one of each engagement. Open-sourcing it does two things: it raises the floor for clients who want to validate that we know what we are doing before they sign anything, and it gives the internal engineering teams at the brands we cannot serve (because we are busy or it is not a fit) a non-trivial head start.

If you fork this and ship it yourself, we are happy that exists. If you want help with the NetSuite setup, the queue hardening, the reconciliation dashboard, or the on-call runbook for when the API rate-limits you at 2am, that is what we do at [avalux.io](https://avalux.io). Reach us through the contact form, with a paragraph on your order volume, your NetSuite edition (OneWorld vs. standard), and what is currently broken.

## Avalux's other open source projects

- [freight-eta-toolkit](https://github.com/avalux-io/freight-eta-toolkit): ETA prediction and geofenced arrival alerts for freight and last-mile
- [avalux-open-source](https://github.com/avalux-io/avalux-open-source): index of all Avalux open-source repositories

## License

MIT. See [LICENSE](LICENSE). Use it, fork it, sell services around it. We ask that you keep the attribution intact.

## Keywords

Shopify NetSuite integration, NetSuite middleware, ecommerce ERP sync, Shopify NetSuite connector open source, NetSuite Sales Order automation, multi-warehouse inventory sync, NetSuite SuiteTalk REST integration, Shopify webhook NetSuite, NetSuite chart of accounts mapping, ecommerce accounting automation, NetSuite OneWorld Shopify, NetSuite TBA OAuth 2.0, Shopify GraphQL Admin API, multi-currency NetSuite Shopify, NetSuite Item Fulfillment Shopify tracking, NetSuite Credit Memo Shopify refund, deferred revenue NetSuite Shopify, ecommerce general ledger automation.
