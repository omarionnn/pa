// The one shape a directions page is built from. Reason's backend makes this once, when it creates
// the page: the routing API's geometry and maneuvers, plus the streets nearby for the map, so the
// page works offline after load and never holds a routing or map key. Anything not in this shape is
// refused here, not guessed at in the browser.
//
// Step semantics (Mapbox-style): a step's `location` is where its instruction is carried out (the
// corner for a turn, the start for "depart", the entrance for "arrive"). Its `distanceM` is the walk
// from that point to the next step's point (0 on the last step).

import { z } from "zod";

export const DIRECTIONS_VERSION = 1;
/** The serialized payload must fit in the page. Route geometry plus nearby streets. */
export const MAX_PAYLOAD_BYTES = 400 * 1024;

const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
const lineCoords = z.array(z.tuple([lng, lat])).min(2).max(2000);

const step = z.object({
  instr: z.string().min(1).max(160),
  // The landmark sentence under the instruction: "Just after the pharmacy. The lane has no name."
  mark: z.string().max(200).default(""),
  // A short phrase for the escort's caption, lower case: "the pharmacy". Optional.
  landmark: z.string().max(40).default(""),
  street: z.string().max(80).default(""),
  distanceM: z.number().min(0).max(100000),
  turn: z.enum(["depart", "straight", "left", "right", "roundabout", "arrive"]),
  location: z.tuple([lng, lat]),
}).strict();

export const directionsPayloadSchema = z.object({
  v: z.literal(DIRECTIONS_VERSION),
  id: z.string().min(1).max(64),
  // Fixture payloads only: they unlock the #escort/<state> preview hashes. Never set by the backend.
  demo: z.boolean().default(false),
  madeAt: z.string().min(1).max(20),
  destination: z.object({
    name: z.string().min(1).max(120),
    address: z.string().min(1).max(240),
    lat,
    lng,
    // Printed entrance description for the last 50 m: "Green gate, next to the tailor's shop."
    entry: z.string().max(160).default(""),
  }).strict(),
  walk: z.object({ minutes: z.number().int().min(0).max(1440), meters: z.number().min(0).max(100000) }).strict(),
  drive: z.object({ minutes: z.number().int().min(0).max(1440) }).strict().optional(),
  route: z.object({
    coordinates: lineCoords,
    distanceM: z.number().min(0).max(100000),
    durationS: z.number().min(0).max(86400),
  }).strict(),
  steps: z.array(step).min(1).max(24),
  // The streets nearby, drawn quietly under the route. Empty is fine: the map still works.
  roads: z.object({
    major: z.array(lineCoords).max(400).default([]),
    minor: z.array(lineCoords).max(1200).default([]),
  }).strict().default({ major: [], minor: [] }),
  event: z.object({
    label: z.string().min(1).max(120),
    href: z.string().url().max(400),
    startsAt: z.string().datetime().optional(),
  }).strict().optional(),
  // Up to four places near the destination, for the "early" moment.
  nearby: z.array(z.string().min(1).max(120)).max(4).default([]),
  // Same-origin path only. The reroute goes through Reason's backend, never a routing key in the page.
  rerouteUrl: z.string().regex(/^\/[^\s"<>]*$/).max(200).optional(),
}).strict().superRefine((p, ctx) => {
  const last = p.steps[p.steps.length - 1];
  if (last.turn !== "arrive") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "the last step must be the arrival" });
  if (p.steps.filter((s) => s.turn === "arrive").length !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "exactly one arrival step" });
});

/**
 * Validates a payload and returns it normalised (defaults filled). Throws a readable error. Also
 * refuses a payload too big to embed.
 */
export function parseDirectionsPayload(input) {
  const bytes = Buffer.byteLength(JSON.stringify(input ?? null), "utf8");
  if (bytes > MAX_PAYLOAD_BYTES) throw new Error(`directions payload is ${bytes} bytes, over the ${MAX_PAYLOAD_BYTES} limit`);
  const res = directionsPayloadSchema.safeParse(input);
  if (!res.success) {
    const first = res.error.issues[0];
    throw new Error(`directions payload: ${first.path.join(".") || "(root)"}: ${first.message}`);
  }
  return res.data;
}
