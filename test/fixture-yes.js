// A gated tool run the way a turn runs it once the person has said yes: the first call (which acts
// on nothing) hands back `use_target`, the ask is recorded against exactly that, the person's reply
// reads as yes, and the tool is called again with the confirmation_id. For tests whose subject is
// what happens AFTER the yes (audit lead 28 put event_blast and the GitHub writes behind the gate).
const said = (text) => ({ role: "user", content: `[Wed, Oct 7 2026, 9:00 AM] ${text}` });

export async function withYes(runTool, name, input, ctx) {
  const first = await runTool(name, input, ctx);
  if (first?.blocked !== "needs_confirmation" || !first.use_target) return first;
  const c = ctx.conversationId;
  const msgs = [said("go on then")];
  const asked = await runTool("confirm_request", { action: name, summary: `${name}: ${first.use_target}`, target: first.use_target, stakes: "third_party" }, { conversationId: c, messages: msgs });
  if (!asked?.confirmation_id) throw new Error(`confirm_request refused: ${JSON.stringify(asked)}`);
  msgs.push({ role: "assistant", content: "asked" }, said("yes send it"));
  const rec = await runTool("confirm_record", { confirmation_id: asked.confirmation_id }, { conversationId: c, messages: msgs, judge: async () => ({ verdict: "yes" }) });
  if (rec?.state !== "granted") throw new Error(`confirm_record did not grant: ${JSON.stringify(rec)}`);
  return runTool(name, { ...input, confirmation_id: asked.confirmation_id }, ctx);
}
