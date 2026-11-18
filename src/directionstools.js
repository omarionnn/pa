// The `directions` tool: Reason makes a real walking trip and hands over its private link (src/trips.js,
// the page is src/pages/directions.js). Behind REASON_DIRECTIONS; "owner" shows it to the owner only.
//
// Whether somebody wants to be walked somewhere is the model's to read, off this description, never a
// keyword match: "how do I get to the party", "walk me to Joe's", "I'm lost, get me back to the hotel".
import { z } from "zod";
import { makeTrip, tripsOnFor } from "./trips.js";

export const DIRECTIONS_TOOLS = new Set(["directions"]);

export function directionsToolVisible(name, conversationId) {
  if (!DIRECTIONS_TOOLS.has(name)) return true;
  return tripsOnFor(conversationId);
}

export const DIRECTIONS_TOOL_DEFS = [
  {
    name: "directions",
    description: "Walking directions they can follow on their phone: makes a private page with the map and the steps, and Escort, which walks them there turn by turn from their phone's own location. Use it whenever they want to get somewhere on foot or ask how to get to a place or an event (\"how do I get to the party\", \"walk me to Joe's\", \"directions to the hotel\") — a Reason event (event_id: its released address and start time come from the event), a saved place (\"home\", \"work\"), or any place or address."
      + " The start, without asking what you can already tell: (1) where they said they are now — pass it as `from`; (2) get_location — a live share or a recent pin, as from_latitude/from_longitude; (3) only if neither, ask where they are and send the Share My Location card (get_location action 'request'). Never guess a start or type coordinates from memory."
      + " Also how far or how long it is to a place, the closest or nearest of a kind included (find it with nearby_places, then call this to it), and what a trip would cost (a taxi, a cab, a car there): call this first for the distance and time and send its link, never guess them or state one you did not check, then give the meter estimate as yours with its working (the miles and minutes it gave, the rates you used, \"my estimate\") and uber_link for the live price."
      + " Give arrive_by when they said when they need to be there (or it is an event: then it is filled in)."
      + " Send the link it returns with one short line; the page says the rest. A long walk comes back with long_walk: offer a ride in the same line (uber_link). A second ask is a fresh call and a fresh link.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Where they are going: an address, a place's name and area, or a saved place's name. Leave out when event_id is given." },
        to_latitude: { type: "number", description: "The destination's latitude, only if a tool gave it (nearby_places). Never typed from memory." },
        to_longitude: { type: "number" },
        event_id: { type: "integer", description: "A Reason event they are in (event_list): walks them to its address, and arrival is judged against its start." },
        place_name: { type: "string", description: "What to call the place on the page, if it has a name (\"Joe's Pizza\")." },
        from: { type: "string", description: "Where they are starting, in words — what they said, or a saved place's name." },
        from_latitude: { type: "number", description: "Where they are, from get_location. Never typed from memory." },
        from_longitude: { type: "number" },
        arrive_by: { type: "string", description: "When they need to be there, their wall-clock time, YYYY-MM-DDTHH:MM. Leave out if they did not say." },
      },
    },
  },
];

export const DIRECTIONS_SCHEMAS = {
  directions: z.object({
    to: z.string().max(300).optional(),
    to_latitude: z.number().min(-90).max(90).optional(),
    to_longitude: z.number().min(-180).max(180).optional(),
    event_id: z.number().int().optional(),
    place_name: z.string().max(120).optional(),
    from: z.string().max(300).optional(),
    from_latitude: z.number().min(-90).max(90).optional(),
    from_longitude: z.number().min(-180).max(180).optional(),
    arrive_by: z.string().max(40).optional(),
  }),
};

const NOT_AVAILABLE = { ok: false, error: "Walking directions are not available here." };

export async function runDirectionsTool(name, input, ctx) {
  const c = ctx.conversationId;
  if (name !== "directions" || !directionsToolVisible(name, c)) return NOT_AVAILABLE;
  if (!input.to && input.event_id == null && input.to_latitude == null) {
    return { ok: false, error: "Where to? Pass `to` (an address, a place, a saved place) or the event_id." };
  }
  return makeTrip(c, input, { geocode: ctx.geocode ?? null, fetchImpl: ctx.fetchImpl ?? fetch, log: ctx.log ?? (() => {}) });
}
