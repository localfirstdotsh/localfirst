import { z } from 'zod';
import { TRUSTED_OPERATIONS } from '@localfirst/contracts';
import { WorkflowError } from './state.js';
import { calculateReplenishment } from './replenishment.js';

const orderSchema = z.object({
  units: z.int().min(0).max(100000), pickup_date: z.string().max(30), pickup_time: z.string().max(20), decoration: z.string().max(200),
  items: z.array(z.object({ sku: z.string().max(100), quantity: z.int().min(0).max(100000) }).strict()).max(100),
}).strict();
const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const validOrder = (o: z.infer<typeof orderSchema>) => o.units > 0 && o.items.length > 0 && o.items.every(i => i.quantity > 0) && o.items.reduce((n, i) => n + i.quantity, 0) === o.units;
const capacityResult = z.object({ available: z.boolean().nullable(), reason: z.string() }).strict();
const priceResult = z.object({ currency: z.string(), total_minor: z.int().nonnegative().nullable(), display_total: z.string().optional(), reason: z.string() }).strict();

/** Fixed coordinator operations: no project code, URLs, paths, writes, or model-selected dispatch. */
export function runOperation(kind: typeof TRUSTED_OPERATIONS[number], raw: Record<string, unknown>): unknown {
  try {
    if (kind === 'replenishment_v1') return calculateReplenishment(z.object({ snapshot: z.unknown() }).strict().parse(raw).snapshot);
    if (kind === 'lookup_v1') {
      const input = z.object({ entries: z.array(z.object({ key: z.string(), value: z.unknown() }).strict()).max(1000), key: z.string() }).strict().parse(raw);
      const matches = input.entries.filter(e => e.key === input.key);
      if (matches.length > 1) throw new WorkflowError('ambiguous_lookup');
      return { found: matches.length === 1, value: matches[0]?.value ?? null };
    }
    if (kind === 'capacity_v1') {
      const input = z.object({ order: orderSchema, calendar: z.object({ slots: z.array(z.object({ date: z.string(), available_units: z.int().nonnegative().max(100000) }).strict()).max(1000) }).strict() }).strict().parse(raw);
      const slots = input.calendar.slots.filter(s => s.date === input.order.pickup_date);
      if (slots.length > 1) throw new WorkflowError('ambiguous_capacity');
      if (!validOrder(input.order) || !validDate(input.order.pickup_date) || !slots[0]) return { available: null, reason: 'capacity_unconfirmed' };
      return { available: slots[0].available_units >= input.order.units, reason: slots[0].available_units >= input.order.units ? 'capacity_available' : 'capacity_unavailable' };
    }
    if (kind === 'price_v1') {
      const input = z.object({
        order: orderSchema,
        catalog: z.object({
          currency: z.string().regex(/^[A-Z]{3}$/),
          minor_unit_digits: z.int().min(0).max(4),
          items: z.array(z.object({ sku: z.string().max(100), unit_minor: z.int().nonnegative().max(10000000) }).strict()).max(1000),
          decorations: z.array(z.object({ key: z.string().max(200), unit_minor: z.int().nonnegative().max(10000000) }).strict()).max(1000),
        }).strict(),
      }).strict().parse(raw);
      const { order, catalog } = input;
      const unavailable = { currency: catalog.currency, total_minor: null, display_total: 'unconfirmed', reason: 'price_unconfirmed' };
      if (!validOrder(order)) return unavailable;
      let total = 0;
      for (const item of order.items) {
        const prices = catalog.items.filter(p => p.sku === item.sku);
        if (prices.length > 1) throw new WorkflowError('ambiguous_price');
        if (!prices[0]) return unavailable;
        total += item.quantity * prices[0].unit_minor;
      }
      const decoration = catalog.decorations.filter(p => p.key === order.decoration);
      if (decoration.length > 1) throw new WorkflowError('ambiguous_price');
      if (!decoration[0]) return unavailable;
      total += decoration[0].unit_minor * order.units;
      if (!Number.isSafeInteger(total)) throw new WorkflowError('price_overflow');
      const scale = 10 ** catalog.minor_unit_digits;
      const fraction = catalog.minor_unit_digits === 0 ? '' : '.' + String(total % scale).padStart(catalog.minor_unit_digits, '0');
      return { currency: catalog.currency, total_minor: total, display_total: catalog.currency + ' ' + Math.floor(total / scale) + fraction, reason: 'price_calculated' };
    }
    if (kind === 'order_decision_v1') {
      const input = z.object({ order: orderSchema, capacity: capacityResult, price: priceResult }).strict().parse(raw);
      const needsInformation = !validOrder(input.order) || !validDate(input.order.pickup_date) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.order.pickup_time) || input.capacity.available === null || input.price.total_minor === null;
      return { status: needsInformation ? 'needs_information' : !input.capacity.available ? 'capacity_unavailable' : 'needs_owner_review' };
    }
    throw new WorkflowError('unsupported_operation');
  } catch (cause) {
    if (cause instanceof WorkflowError) throw cause;
    throw new WorkflowError('operation_input_invalid');
  }
}
