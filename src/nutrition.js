// Pure functions for the meal-estimation feature: validation, rounding, formatting, summing.
// No I/O, no database, no model calls — just arithmetic and text.

const VALID_TYPES = new Set(["plate", "label", "description", "drink"]);
const VALID_CONFIDENCE = new Set(["low", "medium", "high"]);

export function roundKcal(n) {
  return Math.round(Number(n || 0) / 10) * 10;
}

export function roundGrams(n) {
  return Math.round(Number(n || 0) / 5) * 5;
}

export function validateEstimate(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "estimate must be an object" };

  const type = VALID_TYPES.has(raw.type) ? raw.type : "plate";
  const confidence = VALID_CONFIDENCE.has(raw.confidence) ? raw.confidence : "medium";

  const items = Array.isArray(raw.items) ? raw.items.filter(i => typeof i === "string" && i.trim()) : [];
  if (!items.length) return { ok: false, error: "items must list at least one food" };

  const kcalLow = roundKcal(raw.kcal_low);
  const kcalLikely = roundKcal(raw.kcal_likely);
  const kcalHigh = roundKcal(raw.kcal_high);
  if (kcalLikely <= 0) return { ok: false, error: "kcal_likely must be positive" };
  if (kcalLow > kcalLikely) return { ok: false, error: "kcal_low must not exceed kcal_likely" };
  if (kcalHigh < kcalLikely) return { ok: false, error: "kcal_high must not be below kcal_likely" };

  const proteinG = roundGrams(raw.protein_g);
  const carbsG = roundGrams(raw.carbs_g);
  const fatG = roundGrams(raw.fat_g);

  return {
    ok: true,
    value: {
      type,
      items,
      kcal_low: kcalLow,
      kcal_likely: kcalLikely,
      kcal_high: kcalHigh,
      protein_g: proteinG,
      carbs_g: carbsG,
      fat_g: fatG,
      confidence,
      source_note: typeof raw.source_note === "string" ? raw.source_note.trim() : "",
      label_text: typeof raw.label_text === "string" ? raw.label_text.trim() : "",
      question: typeof raw.question === "string" ? raw.question.trim() : "",
      amount_known: raw.amount_known ? 1 : 0,
    },
  };
}

export function formatReply(d) {
  const parts = [];
  if (d.source_note) parts.push(d.source_note.endsWith(".") ? d.source_note : `${d.source_note}.`);
  parts.push(`Roughly ${d.kcal_likely} kcal (${d.kcal_low} to ${d.kcal_high}), about ${d.protein_g} g protein, ${d.carbs_g} g carbs, ${d.fat_g} g fat.`);
  parts.push(`${d.confidence[0].toUpperCase()}${d.confidence.slice(1)} confidence.`);
  if (d.question) parts.push(d.question);
  return parts.join(" ");
}

export function sumMeals(entries) {
  if (!entries?.length) return null;
  let kcalLow = 0, kcalLikely = 0, kcalHigh = 0, protein = 0, carbs = 0, fat = 0;
  for (const e of entries) {
    kcalLow += e.kcal_low ?? 0;
    kcalLikely += e.kcal_likely ?? 0;
    kcalHigh += e.kcal_high ?? 0;
    protein += e.protein_g ?? 0;
    carbs += e.carbs_g ?? 0;
    fat += e.fat_g ?? 0;
  }
  return {
    count: entries.length,
    kcal_low: roundKcal(kcalLow),
    kcal_likely: roundKcal(kcalLikely),
    kcal_high: roundKcal(kcalHigh),
    protein_g: roundGrams(protein),
    carbs_g: roundGrams(carbs),
    fat_g: roundGrams(fat),
  };
}

export function formatSum(s, label = "today") {
  if (!s) return `No meals logged ${label}.`;
  return `${s.count} meal${s.count === 1 ? "" : "s"} ${label}: roughly ${s.kcal_likely} kcal (${s.kcal_low} to ${s.kcal_high}), about ${s.protein_g} g protein, ${s.carbs_g} g carbs, ${s.fat_g} g fat.`;
}
