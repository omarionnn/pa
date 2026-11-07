// Saving a standing permission goes through the normal confirm gate (src/tools.js permission_grant):
// Reason reads it back, the person says yes, and only then is it saved. Tests that are about what a
// permission DOES, rather than about how one is asked for, grant through this: the real flow, end to
// end — permission_grant refused for a yes, confirm_request on the target it handed back, the
// person's yes recorded through confirm_record, then permission_grant again with that id.
//
// `yesJudge` reads the yes; the caller's own `judge` still reads what their original sentence meant.
// Anything permission_grant refuses before it asks (not their words, never standing, no amount) comes
// straight back, unchanged, so a test of a refusal still sees the refusal it is about.
const readsYes = async () => ({ verdict: "yes" });

export async function grantWithYes(runTool, input, ctx, { yes = "yes, save that", yesJudge = readsYes } = {}) {
  const first = await runTool("permission_grant", input, ctx);
  if (first?.ok !== false || first.blocked !== "needs_confirmation") return first;
  const messages = [...(ctx.messages ?? [])];
  const here = { ...ctx, messages };
  const req = await runTool("confirm_request", {
    action: "permission_grant", summary: `save that: ${input.text}?`, stakes: "both", target: first.use_target,
  }, here);
  if (!req?.confirmation_id) return req;
  messages.push({ role: "user", content: yes });
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { ...here, judge: yesJudge });
  if (rec?.state !== "granted") return rec;
  return runTool("permission_grant", { ...input, confirmation_id: req.confirmation_id }, here);
}

/** runTool, with every first permission_grant (no confirmation_id yet) taken through grantWithYes. */
export const grantsViaYes = (runTool, opts) => (name, input, ctx) =>
  name === "permission_grant" && input?.confirmation_id == null ? grantWithYes(runTool, input, ctx, opts) : runTool(name, input, ctx);
