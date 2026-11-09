// The model's side of booking flights through Duffel (src/flightorders.js, REASON_FLIGHT_DUFFEL).
//
// The model picks the moment and reads what the person means. The code owns every fact: prices, the
// Face ID link, what was charged and what was confirmed. Nothing the model passes can set an amount.
import { z } from "zod";
import * as orders from "./flightorders.js";

export const FLIGHT_ORDER_TOOLS = new Set(["flight_fares", "flight_quote", "flight_booking_status", "flight_cancel_quote", "flight_cancel_confirm", "flight_change_options", "flight_change_quote", "flight_airline_change_accept"]);
export const flightOrderToolVisible = (name, c) => !FLIGHT_ORDER_TOOLS.has(name) || orders.enabled(c);

/** Traveler tools are shared with the older AgentCard path, and stay usable here. */
export const FLIGHT_TRAVELER_TOOLS = new Set(["flight_traveler_save", "flight_traveler_confirm", "flight_travelers", "flight_traveler_forget"]);

export const FLIGHT_SEARCH_BOOKABLE = "Reason can book flights end to end: when they want one booked, confirm the travelers (flight_traveler_save, flight_traveler_confirm), then flight_fares for bookable fares and flight_quote for the exact total and the Face ID link. Keep the link on every option too, in case they would rather book it themselves. Never say a flight is booked unless a tool says the airline confirmed it.";

const id = { type: "string" };
const traveler_ids = { type: "array", items: { type: "integer" }, description: "The confirmed travelers flying, from flight_traveler_confirm. One per seat." };
export const FLIGHT_ORDER_TOOL_DEFS = [
  { name: "flight_fares", description: "Bookable fares for a route and date, for confirmed travelers. Prices are the airline's alone; flight_quote gives the full total. Nothing is held or charged.",
    input_schema: { type: "object", properties: { origin: { type: "string", description: "IATA airport code." }, destination: { type: "string", description: "IATA airport code." }, departure_date: { type: "string", description: "YYYY-MM-DD" }, return_date: { type: "string", description: "YYYY-MM-DD, for a round trip." }, cabin: { type: "string", enum: ["economy", "premium_economy", "business", "first"] }, traveler_ids }, required: ["origin", "destination", "departure_date", "traveler_ids"] } },
  { name: "flight_quote", description: "The exact total for one fare they chose, line by line (airline, booking service, Reason's fee), and the Face ID link that approves exactly that. Their Face ID is the only yes that books. Checks card, daily limit and availability first. Nothing is held or charged by this call.",
    input_schema: { type: "object", properties: { offer_id: id, traveler_ids }, required: ["offer_id", "traveler_ids"] } },
  { name: "flight_booking_status", description: "Where their flight bookings stand, from the record. Say only what this says. 'unknown' is not booked.",
    input_schema: { type: "object", properties: { booking_id: id } } },
  { name: "flight_cancel_quote", description: "Ask the airline what cancelling this booking would refund. Changes nothing; show the figure and ask once.",
    input_schema: { type: "object", properties: { booking_id: id }, required: ["booking_id"] } },
  { name: "flight_cancel_confirm", description: "Cancel a booking at the refund just quoted, after they said yes to that figure. They are told the result by text.",
    input_schema: { type: "object", properties: { booking_id: id }, required: ["booking_id"] } },
  { name: "flight_change_options", description: "Other flights the airline will move this booking to, with what each costs or refunds. Changes nothing.",
    input_schema: { type: "object", properties: { booking_id: id, slice_id: { type: "string", description: "The part of the trip being replaced." }, origin: { type: "string" }, destination: { type: "string" }, departure_date: { type: "string", description: "YYYY-MM-DD" }, cabin: { type: "string", enum: ["economy", "premium_economy", "business", "first"] } }, required: ["booking_id", "slice_id", "origin", "destination", "departure_date"] } },
  { name: "flight_change_quote", description: "The Face ID link to make one change they chose. Their Face ID is the yes. Changes nothing until then.",
    input_schema: { type: "object", properties: { booking_id: id, change_offer_id: id }, required: ["booking_id", "change_offer_id"] } },
  { name: "flight_airline_change_accept", description: "Accept a schedule change the airline made, after they said they want to keep the new time. To move or cancel instead, use the change or cancel tools.",
    input_schema: { type: "object", properties: { change_id: id }, required: ["change_id"] } },
];

const code = z.string().regex(/^[A-Za-z]{3}$/).transform(s => s.toUpperCase());
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const cabin = z.enum(["economy", "premium_economy", "business", "first"]).optional();
const ids = z.array(z.number().int()).min(1).max(9);
export const FLIGHT_ORDER_SCHEMAS = {
  flight_fares: z.object({ origin: code, destination: code, departure_date: date, return_date: date.optional(), cabin, traveler_ids: ids }),
  flight_quote: z.object({ offer_id: z.string().min(1).max(100), traveler_ids: ids }),
  flight_booking_status: z.object({ booking_id: z.string().max(100).optional() }),
  flight_cancel_quote: z.object({ booking_id: z.string().min(1).max(100) }),
  flight_cancel_confirm: z.object({ booking_id: z.string().min(1).max(100) }),
  flight_change_options: z.object({ booking_id: z.string().min(1).max(100), slice_id: z.string().min(1).max(100), origin: code, destination: code, departure_date: date, cabin }),
  flight_change_quote: z.object({ booking_id: z.string().min(1).max(100), change_offer_id: z.string().min(1).max(100) }),
  flight_airline_change_accept: z.object({ change_id: z.string().min(1).max(100) }),
};

export function flightOrderTarget(name, input, c) {
  if (name === "flight_cancel_confirm") return orders.cancelTarget(c, input);
  return `flight:airline_change:${input.change_id}`;
}

export async function runFlightOrderTool(name, input, { conversationId: c }) {
  if (!orders.enabled(c)) return { ok: false, blocked: "not_available", error: "Booking flights isn't available here. Hand over the Google Flights link instead, and do not mention this." };
  switch (name) {
    case "flight_fares": return await orders.fares(c, input);
    case "flight_quote": return await orders.quote(c, input);
    case "flight_booking_status": return { ...orders.status(c, input.booking_id ?? null), airline_changes_open: orders.openAirlineChanges(c) };
    case "flight_cancel_quote": return await orders.cancelQuote(c, input.booking_id);
    case "flight_cancel_confirm": return await orders.cancelConfirm(c, input.booking_id);
    case "flight_change_options": return await orders.changeOptions(c, input);
    case "flight_change_quote": return await orders.changeQuote(c, input);
    case "flight_airline_change_accept": return await orders.airlineChangeAccept(c, input.change_id);
  }
  return { ok: false, error: "unknown tool" };
}
