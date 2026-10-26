/* Atelier's business commands, one module per record they move (commands/):
   every change of an order, a payment, a fulfillment, a return or a shelf goes
   through one of these, in one transaction with the ledger and the order's
   summary words. Registered through the --commands entry, never imported
   from the App graph. */
import { defineCommands } from '@mistriwork/mistri/commands';
import { fulfillOrder, shipFulfillment, deliverFulfillment } from './commands/fulfillment.ts';
import { createOrder, confirmOrder, completeOrder, cancelOrder } from './commands/orders.ts';
import { markPaid, refundPayment } from './commands/payments.ts';
import { requestReturn, approveReturn, rejectReturn, receiveReturn, refundReturn } from './commands/returns.ts';
import { receiveStock, adjustStock } from './commands/stock.ts';

export default defineCommands({
  createOrder,
  confirmOrder,
  completeOrder,
  cancelOrder,
  markPaid,
  refundPayment,
  fulfillOrder,
  shipFulfillment,
  deliverFulfillment,
  requestReturn,
  approveReturn,
  rejectReturn,
  receiveReturn,
  refundReturn,
  receiveStock,
  adjustStock,
});
