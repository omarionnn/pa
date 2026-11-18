// Which emoji goes on their text first, chosen by what the text is about (REASON_TAPBACK_TOPIC).
//
// src/tapbackack.js puts a reaction on a text the moment its turn runs its first tool. With this
// switch off that reaction is always 👀. With it on, it says what Reason is working on: 💻 for a
// tech problem, 🛍️ for shopping, ✈️ for a trip. It is decided here, by code, from two things that
// are already known when the first tool has run, so it costs no model call and no prompt words:
//
//   1. the tool and its arguments: a shop tool is shopping, the browser on amazon is shopping,
//      nearby_places for a restaurant is food, a call being placed is a call;
//   2. a small keyword pass over the words of their text, for when the tool does not settle it
//      (a web search about "my wifi keeps dropping" is a tech problem).
//
// A wrong emoji is worse than 👀, so the rule is conservative:
//   - the tool's topic stands only when their words point the same way or nowhere at all;
//   - with no tool topic, their words must point at exactly one topic;
//   - two topics at once is a tie, and a tie is 👀;
//   - anything sensitive (health, money trouble, anything intimate, legal trouble, grief), and any
//     text the safety screen did not clear, is 👀 whatever else it matches: the reaction shows on a
//     lock screen and in a group thread.
//
// THE TABLE IS TOPICS, BELOW. Change a row's emoji, add a tool, a site or a word there and nowhere
// else. Each emoji must be ONE emoji a Sendblue reaction takes (src/expressive.js checkReaction;
// test/ack-topic.test.js checks every row).

/** Does a word list match? Each entry is a RegExp; the text is lowercased first. */
const any = (list, s) => (list ?? []).some(re => re.test(s));

// The two halves of "a tech problem": a thing that runs software AND something wrong with it.
// "find me a new laptop" names a device with nothing wrong; "my sink is broken" has a problem and
// no device. Only both together are 💻.
const DEVICE = /\b(laptop|computer|pc|mac|macbook|imac|iphone|phone|ipad|tablet|printer|monitor|keyboard|mouse|trackpad|airpods|headphones|wi-?fi|internet|router|modem|bluetooth|hotspot|app|apps|website|browser|chrome|safari|excel|word doc|powerpoint|zoom|slack|teams|windows|ios|android|software|update|charger|screen|tv|xbox|ps5|playstation|server|vpn|icloud|hard drive|ssd|usb)\b/;
const PROBLEM = /\b(error|errors|crash|crashed|crashes|crashing|bug|buggy|glitch|glitching|glitchy|frozen|freezes|freezing|not working|isn'?t working|doesn'?t work|stopped working|won'?t (open|load|start|turn on|connect|charge|sync|update|boot|print|work|pair)|can'?t (connect|open|load|pair|print)|keeps (crashing|freezing|restarting|dropping|disconnecting|dying)|disconnect(s|ing|ed)|is dropping|drops out|broken|cracked|lagging|laggy|so slow|really slow|blue screen|black screen|dead pixel|troubleshoot|reinstall|factory reset|virus|malware|spinning wheel)\b/;

export const TOPICS = Object.freeze([
  {
    topic: "tech", emoji: "💻",
    tools: ["github_*", "remote_*", "coding_workspace"],
    both: [DEVICE, PROBLEM],
    words: [/\b(error code|blue screen|kernel panic|stack trace|npm|python script|javascript|my code|terminal command|404 error|500 error)\b/],
  },
  {
    topic: "shopping", emoji: "🛍️",
    tools: ["shop_*", "store_checkout", "purchase", "purchase_confirm", "purchase_track", "purchases_recent", "deal_watch_set"],
    sites: ["amazon.", "target.com", "walmart.", "bestbuy.", "ebay.", "etsy.", "costco.", "nike.", "zara.", "uniqlo.", "sephora.", "ulta.", "wayfair.", "ikea.", "homedepot.", "lowes.", "nordstrom.", "macys."],
    places: ["clothing", "bookstore", "shoes", "mall", "department_store", "electronics"],
    words: [/\b(buy|buying|purchase|shopping|shop for)\b/, /\badd (it |this |that )?to (my )?cart\b/, /\b(back )?in stock\b/, /\bon sale\b/, /\b(promo|discount) code\b/, /\bcoupon\b/, /\bprice drop\b/, /\bcheapest\b/, /\bgift (for|idea)/, /\btrack (my|the|this) (order|package)\b/, /\breturn (my|the|this) (order|package)\b/, /\bamazon\b/],
    not: [/\bbuy (me |us |you )?(some |a little )?(more )?time\b/, /\bi (don'?t )?buy (it|that)\b/],
  },
  {
    topic: "food", emoji: "🍽️",
    tools: ["food_order"],
    sites: ["opentable.", "resy.", "doordash.", "ubereats.", "grubhub.", "seamless.", "tock.", "yelp."],
    places: ["restaurant", "cafe", "bar", "fast_food", "bakery", "ice_cream", "pub", "food_court"],
    words: [/\brestaurants?\b/, /\b(reservation|reservations|a res)\b/, /\b(book|get|grab|make) (us |me )?(a )?table\b/, /\btable for \d/, /\b(dinner|lunch|brunch|breakfast) (spot|place|rec|recs|reservation)\b/, /\bplace to eat\b/, /\bwhere (should|can|do) (we|i) (eat|get (dinner|lunch|brunch|food))\b/, /\border (me |us )?(a |an |some )?(food|pizza|sushi|thai|chinese|takeout|tacos|burgers|dinner|lunch|delivery)\b/, /\b(takeout|take-out|doordash|uber ?eats|grubhub|seamless|resy|opentable)\b/, /\bgrab (a bite|food|drinks)\b/],
  },
  {
    topic: "travel", emoji: "✈️",
    tools: ["flight_*", "boarding_pass"],
    sites: ["expedia.", "booking.com", "airbnb.", "kayak.", "delta.com", "united.com", "aa.com", "southwest.com", "jetblue.com", "marriott.", "hilton.", "hotels.com", "google.com/travel"],
    places: ["hotel", "hostel", "motel"],
    words: [/\b(flight|flights|airline|airport|layover|boarding pass|carry-?on)\b/, /\bfly(ing)? (to|out|home|back)\b/, /\b(hotel|hotels|airbnb|motel|hostel)\b/, /\btrip to\b/, /\b(vacation|itinerary|passport)\b/],
  },
  {
    topic: "ride", emoji: "🚕",
    tools: ["uber_request", "uber_options", "uber_ride", "uber_cancel", "uber_receipt", "uber_link", "event_ride"],
    words: [/\b(uber|lyft|cab|taxi)\b/, /\b(get|book|call|order) (me |us )?(a )?(ride|car)\b/],
  },
  {
    topic: "directions", emoji: "🗺️",
    tools: ["directions", "transit_status"],
    sites: ["maps.google.", "maps.apple.", "google.com/maps"],
    words: [/\bdirections\b/, /\bhow (do i|do we|long (does it take|to)) get (to|there|home)\b/, /\bhow far (is|away|from)\b/, /\b(traffic|commute)\b/, /\b(train|subway|bus|metro) (times|delays|schedule|running)\b/],
  },
  {
    topic: "money", emoji: "💳",
    tools: ["bank", "spend_today", "spend_limit_set", "spend_limit_confirm", "account_bill_pay", "subscription_*", "subscriptions_scan"],
    sites: ["chase.com", "bankofamerica.", "wellsfargo.", "capitalone.", "americanexpress.", "venmo.", "paypal."],
    places: ["bank", "atm"],
    words: [/\b(bank account|checking account|savings account|my balance|account balance|transactions|credit card|my statement|venmo|zelle|paypal|subscriptions?)\b/, /\bhow much (did )?(i|we) (spend|spent)\b/, /\bmy spending\b/, /\bpay (my|the) (bill|card|rent)\b/],
  },
  {
    topic: "calendar", emoji: "📅",
    tools: ["calendar_*", "apple_calendar_*", "conflict_check", "conflict_resolve", "meeting_brief"],
    words: [/\b(calendar|reschedule|meeting|meetings|appointment|availability)\b/, /\bam i free\b/, /\bblock (off )?(time|an hour|the afternoon|the morning)\b/, /\bschedule (a|my|the|an)\b/, /\bmy schedule\b/, /\bsend (him|her|them|\w+) an invite\b/],
  },
  {
    topic: "email", emoji: "✉️",
    tools: ["gmail_*"],
    sites: ["mail.google."],
    words: [/\b(email|emails|e-mail|inbox|gmail|unsubscribe|newsletter)\b/],
  },
  {
    topic: "call", emoji: "📞",
    tools: ["call_place", "call_errand_start"],
    words: [/\b(can you|could you|please|pls|plz) (call|phone|ring)\b/, /\bgive (them|him|her|\w+) a call\b/, /\bmake a (phone )?call\b/, /\bcall (them|the \w+) (and|to) (ask|book|cancel|check|see|find out)\b/],
  },
  {
    topic: "writing", emoji: "📝",
    tools: ["document_create", "page_create", "page_update", "drive_create"],
    sites: ["docs.google."],
    words: [/\b(cover letter|essay|proofread)\b/, /\b(my|a) (resume|résumé|cv)\b/, /\b(write|draft|rewrite|edit) (me |up )?(a|an|the|my)? ?(doc|document|report|memo|proposal|summary|post|caption|letter|note|toast|speech|bio|outline)\b/, /\bmake (me )?a (doc|document|pdf|spreadsheet|deck|presentation)\b/],
  },
  {
    topic: "research", emoji: "🔍",
    tools: ["research"],
    words: [/\b(research|deep dive)\b/, /\blook into\b/],
  },
  {
    // ⏰ means a reminder IS set, so it is never put on before one is: their words saying "remind
    // me" only mark the topic (so "remind me to buy milk" is a tie and not 🛍️); the ⏰ itself comes
    // with timer_set succeeding (src/tapbackack.js).
    topic: "reminder", emoji: "⏰", onlyOnceSet: true,
    words: [/\bremind (me|us|him|her|them)\b/, /\b(reminder|alarm|timer)\b/, /\bdon'?t let me forget\b/, /\bwake me\b/],
  },
  {
    topic: "fitness", emoji: "💪",
    places: ["gym", "fitness_centre", "sports_centre"],
    // Leaving a gym is a membership being cancelled, not a workout.
    not: [/\b(cancel\w*|quit|quitting|freeze|pause) (my |the |our )?(gym|membership|classpass|equinox|peloton)\b/],
    words: [/\b(gym|workout|workouts|work out|lifting|yoga|pilates|crossfit|spin class|marathon|half marathon|5k|10k|personal trainer|training plan|run club|climbing gym)\b/],
  },
  {
    topic: "music", emoji: "🎵",
    tools: ["spotify_*"],
    sites: ["open.spotify.", "music.apple.", "soundcloud."],
    words: [/\b(playlist|playlists|spotify|apple music|song|songs|album|lyrics|concert)\b/, /\bplay (me |some )?(music|something)\b/],
  },
  {
    topic: "video", emoji: "🎬",
    tools: ["video_understand"],
    sites: ["youtube.", "youtu.be", "netflix.", "vimeo.", "tiktok."],
    words: [/\b(youtube|youtu\.be|netflix|hulu|trailer|movie|movies|film)\b/, /\bvideo\b/],
    not: [/\bvideo (call|chat|meeting)\b/],
  },
  {
    topic: "signin", emoji: "🔑",
    tools: ["signin_*", "account_signin", "account_connect", "saved_login_offer", "saved_login_forget", "vault_enroll", "google_connect", "github_connect", "spotify_connect", "uber_connect", "x_connect"],
    words: [/\b(log ?in|sign ?in|sign-in|password|2fa|two-factor|verification code|locked out)\b/],
  },
]);

/**
 * Never a topic emoji on these, whatever else the text says: a reaction is seen on a lock screen and
 * by everyone in a group thread. Matched over their words AND the tool's arguments (a shop search for
 * a pregnancy test is not 🛍️). Erring wide costs nothing: the answer is 👀, which is today.
 */
export const SENSITIVE = [
  // health and the body
  /\b(moles?|itch(y|ing)?|swollen|swelling|bleeding|bruis\w*|injur\w*|sprain\w*|concussion|allerg\w*|nause\w*|vomit\w*|throw(ing)? up|migraine|headache|stomach ache|blood pressure)\b/,
  /\b(doctor|dr\.|dentist|therapist|therapy|psychiatrist|symptoms?|sick|fever|pain|hurts|rash|lump|infection|std|sti|hiv|pregnan\w*|my period|birth control|plan b|condoms?|viagra|prescriptions?|meds|medication|pharmacy|diagnos\w*|cancer|diabetes|hospital|urgent care|er visit|rehab|sober|depress\w*|anxiety|panic attack|adhd|weight loss|lose weight|diet|calories|ozempic|surgery|biopsy|test results)\b/,
  // money trouble
  /\b(card|payment|transaction)s? (got |was |were |keeps getting |is being )?(declined|denied|rejected|frozen)\b/,
  /\b(debt|overdraft|overdrawn|i'?m broke|we'?re broke|so broke|flat broke|can'?t afford|collections|bankrupt\w*|evict\w*|payday loan|behind on|late on (rent|my)|loan shark|repo(ssess\w*)?)\b/,
  // anything intimate
  /\b(sex|sexy|lingerie|hook ?up|nudes|onlyfans|tinder|hinge|bumble|grindr|dating app|breakup|break up|broke up|divorce|cheating|affair)\b/,
  // legal trouble, grief, work trouble
  /\b(lawyer|attorney|arrest\w*|dui|court date|lawsuit|sued|police|funeral|passed away|grief|condolences|fired|laid off|layoffs?)\b/,
  // the safety screen's subjects, caught here too in case its verdict is not on the ctx
  /\b(kill|suicide|self[- ]harm|hurt (myself|someone)|weapon|gun|drugs?)\b/,
];

/** Tools whose topic is the body or money trouble by nature: 👀, never a topic. */
const SENSITIVE_TOOLS = ["meal_*", "pay_by_phone"];

const toolMatches = (pattern, name) => pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;

/** The input's words that say what a tool is for: a url, a search, a place type. Never the whole input. */
function inputWords(input) {
  if (!input || typeof input !== "object") return { url: "", words: "" };
  const pick = (k) => (typeof input[k] === "string" ? input[k] : "");
  const url = pick("url").toLowerCase();
  const words = ["query", "q", "search", "question", "type", "cuisine", "name", "category", "item", "product"].map(pick).filter(Boolean).join(" ").toLowerCase();
  return { url, words };
}

/** The row a tool belongs to by its name, or null. An exact name beats a prefix (spotify_connect is 🔑, not 🎵). */
function toolRow(name) {
  const exact = TOPICS.filter(r => (r.tools ?? []).includes(name));
  if (exact.length) return exact.length === 1 ? exact[0] : "tie";
  const pre = TOPICS.filter(r => (r.tools ?? []).some(p => p.endsWith("*") && toolMatches(p, name)));
  return pre.length === 1 ? pre[0] : pre.length > 1 ? "tie" : null;
}

/** The row a browser page or a nearby search belongs to, from where it points. */
function placeRow(url, type) {
  const rows = new Set();
  if (url) for (const r of TOPICS) if ((r.sites ?? []).some(s => url.includes(s))) rows.add(r);
  if (type) for (const r of TOPICS) if ((r.places ?? []).some(p => new RegExp(`\\b${p}\\b`).test(type))) rows.add(r);
  return rows.size === 1 ? [...rows][0] : rows.size > 1 ? "tie" : null;
}

/** Every row their words point at. */
export function wordTopics(text) {
  const s = String(text ?? "").toLowerCase().replace(/[’‘]/g, "'");
  if (!s.trim()) return [];
  return TOPICS.filter(r => {
    if (any(r.not, s)) return false;
    if (any(r.words, s)) return true;
    return Array.isArray(r.both) && r.both.every(re => re.test(s));
  });
}

export const isSensitive = (s) => any(SENSITIVE, String(s ?? "").toLowerCase().replace(/[’‘]/g, "'"));

/**
 * What their text is about, from the first tool and their words. Returns
 *   { topic, emoji, why }   when one topic is clear, or
 *   { topic: null, why }    when it is not: no match, a tie, sensitive, or not cleared by the screen.
 * `harm` is the turn's screen verdict object when it is not 'clear' (src/runtime.js puts it on ctx).
 */
export function topicFor({ tool = "", input = null, text = "", harm = null } = {}) {
  if (harm && harm.verdict !== "clear") return { topic: null, why: "screen" };
  const name = String(tool ?? "");
  const { url, words } = inputWords(input);
  if (SENSITIVE_TOOLS.some(p => toolMatches(p, name))) return { topic: null, why: "sensitive" };
  if (isSensitive(`${text}\n${words}\n${url}`)) return { topic: null, why: "sensitive" };

  // What the tool says. A page or a nearby search says it by where it points.
  let byTool = toolRow(name);
  if (!byTool && (name.startsWith("browser_") || name === "nearby_places")) byTool = placeRow(url, String(input?.type ?? "").toLowerCase());
  if (byTool === "tie") return { topic: null, why: "tie" };

  // What their words say (with the search the tool was given, which is their words restated).
  const said = wordTopics(`${text}\n${words}`);
  if (byTool) {
    // Their words must point nowhere or at this topic alone: a second topic beside it is a tie ("book a
    // table and get me an uber there" is 👀, not 🍽️).
    if (said.length === 0 || (said.length === 1 && said[0] === byTool)) return { topic: byTool.topic, emoji: byTool.emoji, why: said.length ? "tool+words" : "tool" };
    return { topic: null, why: "tie" };
  }
  if (said.length === 1) return { topic: said[0].topic, emoji: said[0].emoji, why: "words" };
  return { topic: null, why: said.length ? "tie" : "none" };
}
