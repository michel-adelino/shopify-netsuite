/**
 * Maps a Shopify Order webhook payload to a NetSuite Sales Order REST payload.
 * This is the canonical translation point. Account mapping, location routing,
 * tax decomposition, and FX rate locking all happen here.
 */

import type { ShopifyOrder, ShopifyLineItem, ShopifyTaxLine } from "../shopify/types";
import type { NetSuiteSalesOrder, NetSuiteItemLine } from "../netsuite/types";
import { accountMap } from "../config/accountMap";
import { locationMap } from "../config/locationMap";
import { taxCodeMap } from "../config/taxCodeMap";

export interface MappingContext {
  subsidiaryId: number;
  shopifyChannelClassId: number;
  defaultCustomerInternalId: number;
  resolveCustomer: (order: ShopifyOrder) => Promise<{ internalId: number }>;
  resolveItem: (sku: string) => Promise<{ internalId: number; defaultAccount?: string }>;
  fxRateProvider?: (currency: string, isoDate: string) => Promise<number>;
}

export async function orderToSalesOrder(
  order: ShopifyOrder,
  ctx: MappingContext
): Promise<NetSuiteSalesOrder> {
  if (order.cancelled_at) {
    throw new Error(`Order ${order.id} is cancelled, refusing to create SO`);
  }

  const customer = await ctx.resolveCustomer(order);
  const location = routeFulfillmentLocation(order);
  const exchangeRate = await resolveExchangeRate(order, ctx);

  const itemLines = await Promise.all(
    order.line_items.map((li) => mapLineItem(li, ctx))
  );

  const lines: NetSuiteItemLine[] = [
    ...itemLines,
    ...buildDiscountLines(order),
    ...buildShippingLines(order),
    ...buildTaxLines(order),
  ];

  return {
    entity: { id: customer.internalId },
    subsidiary: { id: ctx.subsidiaryId },
    location: { id: location.internalId },
    class: { id: ctx.shopifyChannelClassId },
    tranDate: order.processed_at.slice(0, 10),
    otherRefNum: order.name,
    memo: `Shopify ${order.name} (id ${order.id})`,
    currency: { refName: order.currency },
    exchangeRate,
    item: { items: lines },
    customFieldList: {
      custbody_shopify_order_id: String(order.id),
      custbody_shopify_order_name: order.name,
      custbody_shopify_gateway: (order.payment_gateway_names ?? []).join(","),
      custbody_shopify_financial_status: order.financial_status ?? "",
    },
  };
}

async function mapLineItem(
  li: ShopifyLineItem,
  ctx: MappingContext
): Promise<NetSuiteItemLine> {
  const item = await ctx.resolveItem(li.sku);
  const collectionKey = li.product_id != null ? `gid://shopify/Collection/${li.product_id}` : "";
  const account =
    item.defaultAccount ??
    accountMap.revenue.by_collection?.[collectionKey] ??
    accountMap.revenue.default;

  return {
    item: { id: item.internalId },
    quantity: li.quantity,
    rate: parseFloat(li.price),
    amount: parseFloat(li.price) * li.quantity,
    account: { refName: account },
    taxCode: { refName: resolveTaxCode(li.tax_lines) },
  };
}

function buildDiscountLines(order: ShopifyOrder): NetSuiteItemLine[] {
  const total = parseFloat(order.total_discounts ?? "0");
  if (total <= 0) return [];
  return [{
    item: { id: accountMap.items.discount },
    quantity: 1,
    rate: -total,
    amount: -total,
    account: { refName: accountMap.discount_contra },
    taxCode: { refName: "-Not Taxable-" },
  }];
}

function buildShippingLines(order: ShopifyOrder): NetSuiteItemLine[] {
  const shipping = (order.shipping_lines ?? []).reduce(
    (sum, s) => sum + parseFloat(s.price),
    0
  );
  if (shipping === 0) return [];
  return [{
    item: { id: accountMap.items.shipping },
    quantity: 1,
    rate: shipping,
    amount: shipping,
    account: { refName: accountMap.shipping_income },
    taxCode: { refName: "-Not Taxable-" },
  }];
}

function buildTaxLines(order: ShopifyOrder): NetSuiteItemLine[] {
  return (order.tax_lines ?? []).map((tl) => ({
    item: { id: accountMap.items.taxAdjustment },
    quantity: 1,
    rate: parseFloat(tl.price),
    amount: parseFloat(tl.price),
    account: { refName: accountMap.sales_tax_payable },
    taxCode: { refName: resolveTaxCode([tl]) },
  }));
}

function resolveTaxCode(taxLines: ShopifyTaxLine[] | undefined): string {
  if (!taxLines || taxLines.length === 0) return "-Not Taxable-";
  const fingerprint = taxLines
    .map((t) => `${t.title}:${t.rate}`)
    .sort()
    .join("|");
  return taxCodeMap[fingerprint] ?? taxCodeMap.default;
}

function routeFulfillmentLocation(order: ShopifyOrder): { internalId: number } {
  const state = order.shipping_address?.province_code ?? "";
  const zone = locationMap.routing.zones.find((z) => new RegExp(z.regex).test(state));
  if (zone) return { internalId: zone.primary };
  return { internalId: locationMap.routing.fallback };
}

async function resolveExchangeRate(
  order: ShopifyOrder,
  ctx: MappingContext
): Promise<number> {
  if (order.currency === "USD") return 1;
  if (order.presentment_currency_rate) return parseFloat(order.presentment_currency_rate);
  if (ctx.fxRateProvider) return ctx.fxRateProvider(order.currency, order.processed_at);
  return 1;
}
