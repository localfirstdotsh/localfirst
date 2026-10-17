import { digestOf, stockSnapshotSchema } from '@localfirst/contracts';
import { WorkflowError } from './state.js';

const day = (date: string) => Date.parse(date + 'T00:00:00Z') / 86400000;
function unique<T>(items: T[], key: (item: T) => string): T[] {
  const result = new Map<string, T>();
  for (const item of items) {
    const id = key(item), previous = result.get(id);
    if (previous && digestOf(previous) !== digestOf(item)) throw new WorkflowError('conflicting_stock_records');
    result.set(id, item);
  }
  return [...result.values()];
}

/** Pure single-SKU snapshot arithmetic. No fetching, persistent state, purchasing or messaging. */
export function calculateReplenishment(raw: unknown) {
  const snapshot = stockSnapshotSchema.parse(raw), { settings } = snapshot;
  const today = day(snapshot.as_of), start = today - settings.lookback_days;
  if (snapshot.inventory.reserved > snapshot.inventory.on_hand) throw new WorkflowError('invalid_stock_reservation');
  const orders = unique(snapshot.orders, o => o.line_id);
  if (orders.some(o => o.returned_quantity > o.quantity || day(o.ordered_on) > today)) throw new WorkflowError('invalid_stock_sales');
  const window = orders.filter(o => o.sku === snapshot.sku && day(o.ordered_on) >= start && day(o.ordered_on) < today);
  const net = window.reduce((sum, order) => sum + (order.cancelled ? 0 : order.quantity - order.returned_quantity), 0);
  const available = snapshot.inventory.on_hand - snapshot.inventory.reserved;
  const purchaseOrders = unique(snapshot.purchase_orders, o => o.id).filter(o => o.sku === snapshot.sku && o.status === 'confirmed');
  const proposals = unique(snapshot.pending_proposals, o => o.id);
  const quotes = unique(snapshot.quotes, q => q.vendor_id);
  const inbound = purchaseOrders.filter(o => day(o.due_on) >= today && day(o.due_on) <= today + settings.target_days).reduce((sum, order) => sum + order.quantity, 0);
  const position = available + inbound;
  const base = {
    sku: snapshot.sku, as_of: snapshot.as_of, currency: settings.currency,
    net_units: net, lookback_days: settings.lookback_days, daily_units: net / settings.lookback_days,
    available_units: available, confirmed_inbound: inbound, inventory_position: position,
    coverage_days: net === 0 ? null : available * settings.lookback_days / net,
    quantity: 0, total_minor: 0, display_total: 'no purchase proposed', vendor_id: '',
    supplier_confirmed_on: '', lead_days: 0, reorder_point: 0, delivery_risk: false,
    approval_required: true, shipping_tax_included: false, execution_mode: 'snapshot_only',
  };
  const result = (status: string, reason: string) => ({ ...base, status, reason });
  if (snapshot.inventory.observed_on !== snapshot.as_of || purchaseOrders.some(o => day(o.due_on) < today)) return result('needs_information', 'Reconcile stale inventory or overdue purchase orders before planning.');
  if (proposals.some(p => p.sku === snapshot.sku && p.status !== 'declined')) return result('proposal_already_pending', 'An owner proposal is pending or approved in this snapshot; reconcile it before creating another.');
  if (window.length === 0) return result('needs_information', 'No sales observations in the closed lookback window; zero demand cannot be inferred.');
  let arrivals = available * settings.lookback_days, previousDay = today;
  for (const incoming of purchaseOrders.filter(o => day(o.due_on) <= today + settings.target_days).sort((a, b) => day(a.due_on) - day(b.due_on))) {
    const elapsed = day(incoming.due_on) - previousDay;
    if (arrivals < net * elapsed) return result('needs_information', 'Confirmed inbound arrives after projected stock depletion; reconcile the existing order before another proposal.');
    arrivals += incoming.quantity * settings.lookback_days - net * elapsed;
    previousDay = day(incoming.due_on);
  }
  if (net === 0 || position * settings.lookback_days >= net * settings.target_days) return result('no_reorder_needed', 'Available stock and confirmed inbound already cover the target demand.');
  const fresh = quotes.filter(q => q.sku === snapshot.sku && q.availability === 'confirmed' && day(q.quoted_on) <= today && today - day(q.quoted_on) <= settings.max_quote_age_days);
  if (fresh.length === 0) return result('needs_supplier_confirmation', 'No current confirmed supplier availability in the dated snapshot.');
  const needed = Math.ceil(net * settings.target_days / settings.lookback_days) - position;
  const candidates = fresh.map(quote => {
    const quantity = Math.ceil(Math.max(needed, quote.min_units) / quote.pack_size) * quote.pack_size;
    return { quote, quantity };
  }).filter(c => c.quantity <= c.quote.available_units && c.quote.lead_days + settings.safety_days < settings.target_days)
    .map(c => ({ ...c, total: c.quantity * c.quote.unit_minor }));
  if (candidates.length === 0) return result('no_feasible_vendor', 'No confirmed supplier can fulfill the full pack-rounded quantity within the target horizon; partial orders are unsupported.');
  if (candidates.every(c => position * settings.lookback_days > net * (c.quote.lead_days + settings.safety_days))) return result('no_reorder_needed', 'Feasible supplier lead times and the safety buffer remain covered.');
  const affordable = candidates.filter(c => c.total <= settings.budget_minor);
  if (affordable.length === 0) return result('budget_exceeded', 'Every feasible complete proposal exceeds the configured merchandise budget; shipping and tax are additional.');
  affordable.sort((a, b) => a.total - b.total || a.quote.lead_days - b.quote.lead_days || (a.quote.vendor_id < b.quote.vendor_id ? -1 : a.quote.vendor_id > b.quote.vendor_id ? 1 : 0));
  const chosen = affordable[0]!;
  const threshold = net * (chosen.quote.lead_days + settings.safety_days);
  if (position * settings.lookback_days > threshold) return result('no_reorder_needed', 'The selected feasible supplier lead time plus safety buffer is covered.');
  // Inbound due after the selected delivery cannot prevent an earlier stockout.
  const inboundByDelivery = purchaseOrders.filter(o => day(o.due_on) >= today && day(o.due_on) <= today + chosen.quote.lead_days).reduce((sum, order) => sum + order.quantity, 0);
  return {
    ...base, status: 'needs_owner_review', reason: 'Reorder threshold reached. Review the dated supplier availability and approve separately before purchasing.',
    quantity: chosen.quantity, total_minor: chosen.total,
    display_total: 'USD ' + Math.floor(chosen.total / 100) + '.' + String(chosen.total % 100).padStart(2, '0'),
    vendor_id: chosen.quote.vendor_id, supplier_confirmed_on: chosen.quote.quoted_on, lead_days: chosen.quote.lead_days,
    reorder_point: Math.ceil(threshold / settings.lookback_days),
    delivery_risk: (available + inboundByDelivery) * settings.lookback_days < net * chosen.quote.lead_days,
  };
}
