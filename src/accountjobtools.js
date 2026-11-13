// The model's side of account jobs (src/accountjobs.js), behind REASON_ACCOUNT_JOBS.
//
//   account_cancel         — start cancelling one subscription inside their account. Nothing is cancelled
//                            by it: the run stops at the last step and the model is told what it found.
//   account_cancel_confirm — the last step, answered yes. Gated in src/tools.js like shop_pay: the yes is
//                            pinned to this job, plan, site, run and open question (jobs.cancelTarget).
//   account_bill_pay       — start paying one bill from a notice on the biller's own page. Nothing is
//                            paid by it: the exact total goes to them through the shopping pay path.
//   account_job_answer     — a plain answer to a job's question (their email, a ZIP, a code they sent).
//   account_job_status     — where their jobs stand, from the record.
//   account_job_stop       — they said no, or changed their mind.
//
// Where these are on for someone, the older cancel route that walks Reason's own browser
// (subscription_cancel_start / subscription_cancel_commit) is hidden and refused, and signin_link is
// refused for a site a job is working on: that route ends in Reason's browser shown as a picture, which
// the owner ruled out on 2026-11-12. Everybody else keeps today's tools exactly.
import { z } from "zod";
import * as jobs from "./accountjobs.js";
import { PLAYBOOKS } from "./playbooks.js";

export const ACCOUNT_JOB_TOOLS = new Set(["account_cancel", "account_cancel_confirm", "account_bill_pay", "account_job_answer", "account_job_status", "account_job_stop"]);
export const accountJobToolVisible = (name, conversationId) => !ACCOUNT_JOB_TOOLS.has(name) || jobs.jobsAllowedFor(conversationId);
export const ACCOUNT_JOB_REFUSAL = { ok: false, blocked: "not_available", error: "Reason doesn't do that here. Do not mention it." };

/** The browser-walking cancel tools: never shown, never run where account jobs are on. */
export const BROWSER_CANCEL_TOOLS = new Set(["subscription_cancel_start", "subscription_cancel_commit"]);
export const browserCancelToolVisible = (name, conversationId) => !BROWSER_CANCEL_TOOLS.has(name) || !jobs.jobsAllowedFor(conversationId);
export const BROWSER_CANCEL_REFUSAL = { ok: false, blocked: "not_available", error: "Cancelling a subscription goes through account_cancel here. Use that, and do not mention this." };

/**
 * The cancelling rules as an account-jobs conversation reads them (they ride on cancel_route's
 * description, src/playbooks.js): the web rail is account_cancel, and nobody is sent a sign-in link.
 */
const OLD_CANCEL_RULES = PLAYBOOKS.find((p) => p.name === "cancelling")?.text ?? "";
export const CANCEL_RULES = "- Cancelling a subscription that is managed on a website goes through account_cancel: it works inside their own account from start to finish, and comes back with exactly what gets cancelled and when it ends before anything is final. Never walk a cancel page yourself and never send a sign-in link for it; where a result names subscription_cancel_start, that is account_cancel here. cancel_route still says what kind of service it is. An App Store subscription is four taps in Settings on their own phone: say the taps, do not offer to do it. A service that only cancels over the PHONE you cannot do yet: say that plainly. A WRITTEN request is a draft they see whole, and it only goes with gmail_send after a yes.";
export function accountJobWords(text) {
  const t = String(text ?? "");
  return OLD_CANCEL_RULES && t.includes(OLD_CANCEL_RULES) ? t.replace(OLD_CANCEL_RULES, CANCEL_RULES) : t;
}

/**
 * signin_link for a site an account job is working on (or worked on in the last day): refused. The
 * job signs in itself, in its own order, and that link shows Reason's browser as a picture.
 */
export function signinLinkRefusal(conversationId, site) {
  if (!jobs.jobsAllowedFor(conversationId)) return null;
  const job = jobs.jobForSite(conversationId, site);
  if (!job) return null;
  return {
    ok: false, blocked: "handled_by_account_job", job_id: job.id,
    error: `No link was made. ${job.name} is being handled by account job ${job.id}, which signs in on its own: a saved sign-in, a code from their mail, a code they send here, or one sign-in page it texts itself. account_job_status says where it stands; say that, and never send a sign-in link for this.`,
  };
}

export const ACCOUNT_JOB_TOOL_DEFS = [
  {
    name: "account_cancel",
    description: "Cancel ONE subscription inside their own account at the merchant, start to finish. Only when THEY asked to cancel it (their own message, or a tap on a card that offered it). NOTHING IS CANCELLED BY THIS TOOL: it starts a run in their own saved browser profile that signs in if it has to, finds the plan and STOPS at the last step. You then get an [account job] event with exactly what the site says will be cancelled and when access ends; ask them one plain line with that, and their yes goes through account_cancel_confirm. It can never pay: any charge ends it. Sign-in is handled inside the job (a saved sign-in, a code from their mail, a code they send here, or one sign-in page texted once), so never offer signin_link or any other sign-in for it. Afterwards I text them the result myself, and it is only 'done' when the site said cancelled AND, where their mail is connected, the merchant's cancellation email arrived. Until then never say it is cancelled.",
    input_schema: {
      type: "object",
      properties: {
        site: { type: "string", description: "The site the subscription is MANAGED on, from the notice or from them: e.g. netflix.com. Where a billing service runs it, that service's site." },
        plan: { type: "string", description: "The plan's name exactly as the notice or they named it: 'Cardboard Starter'." },
        name: { type: "string", description: "What the merchant is called, for the lines they are sent: 'Cardboard'." },
        page: { type: "string", description: "The manage-subscription page's https address, when the notice gives one on that same site." },
        notice_from: { type: "string", description: "The sender domain of the merchant's own emails about this subscription (from the notice), when it is not the site's: 'stripe.com'." },
      },
      required: ["site", "plan"],
    },
  },
  {
    name: "account_cancel_confirm",
    description: "The last step of a cancellation: THE ONLY TOOL THAT CANCELS. Only after the [account job] event said the site is at its last step and they said yes to your one plain line. Call it first with just job_id: it refuses with `use_target`; pass that verbatim as confirm_request's target, then their real answer, then confirm_record, then this again with the confirmation_id. The yes is pinned to this job's plan, site and open question, so it can never be spent on another. Afterwards say only that it is going through: the result is texted when the site shows it.",
    input_schema: {
      type: "object",
      properties: {
        job_id: { type: "integer", description: "From the [account job] event." },
        confirmation_id: { type: "integer", description: "From confirm_record, granted." },
        answers: { type: "object", description: "Only when this tool said the last step could not be answered by code: field key → the exact option for going ahead.", additionalProperties: true },
      },
      required: ["job_id"],
    },
  },
  {
    name: "account_bill_pay",
    description: "Pay ONE specific bill from a notice, on the biller's own website (its guest-pay page where it has one, their signed-in account otherwise). Only when THEY asked to pay it. Needs, from the notice itself and never guessed: the biller, the amount due, and the account or invoice number. NOTHING IS PAID BY THIS TOOL: the run stops at payment and they are texted the biller's EXACT total to approve; that approval (the same one a store checkout uses, their daily limit included) is the only thing that pays. Sign-in, if the biller needs it, is handled inside the job; never offer signin_link for it. Afterwards I text them the result myself: 'paid' needs the payment page's receipt AND, where their mail is connected, the biller's confirmation email.",
    input_schema: {
      type: "object",
      properties: {
        biller: { type: "string", description: "Who is billing, as the notice names them: 'Con Edison'." },
        site: { type: "string", description: "The biller's own site, from the notice: coned.com." },
        amount: { type: "number", description: "The amount due on the notice, in dollars." },
        reference: { type: "string", description: "The account number or invoice number on the notice, exactly." },
        due_date: { type: "string", description: "The due date on the notice, as written." },
        page: { type: "string", description: "The notice's own pay-this-bill https address on that same site, when it gives one." },
        notice_from: { type: "string", description: "The sender domain of the biller's emails, when it is not the site's." },
      },
      required: ["biller", "site", "amount", "reference"],
    },
  },
  {
    name: "account_job_answer",
    description: "Answer a plain question an account job is waiting on (an [account job] event listed the fields): their email, a ZIP that finds the bill, which account, or the one-time code they just sent you in the thread. Keys exactly as listed. Never a password, never a card number, and never a cancellation's last step (that is account_cancel_confirm). Nothing is cancelled or paid by this.",
    input_schema: {
      type: "object",
      properties: {
        job_id: { type: "integer" },
        answers: { type: "object", description: "field key → value.", additionalProperties: true },
      },
      required: ["job_id", "answers"],
    },
  },
  {
    name: "account_job_status",
    description: "Where their account jobs (a cancellation, a bill) stand, from the record: what each is waiting on, whether it is done, and which proof was seen (the site's page, the merchant's email). CALL IT before answering 'did it cancel?', 'is it paid?', 'any update?': never answer those from memory.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "account_job_stop",
    description: "They said no to a cancellation's last step, or changed their mind about a job that is still open: the site is told no and the run is ended. Nothing is cancelled and nothing is paid.",
    input_schema: { type: "object", properties: { job_id: { type: "integer" } }, required: ["job_id"] },
  },
];

const answersShape = z.record(z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(200)).max(20)]));
export const ACCOUNT_JOB_SCHEMAS = {
  account_cancel: z.object({ site: z.string().min(3).max(300), plan: z.string().min(1).max(80), name: z.string().max(60).optional(), page: z.string().url().max(1000).optional(), notice_from: z.string().max(200).optional() }),
  account_cancel_confirm: z.object({ job_id: z.number().int().positive(), confirmation_id: z.number().int().optional(), answers: answersShape.optional() }),
  account_bill_pay: z.object({ biller: z.string().min(1).max(60), site: z.string().min(3).max(300), amount: z.number().positive().max(5000), reference: z.string().min(1).max(60), due_date: z.string().max(40).optional(), page: z.string().url().max(1000).optional(), notice_from: z.string().max(200).optional() }),
  account_job_answer: z.object({ job_id: z.number().int().positive(), answers: answersShape }),
  account_job_status: z.object({}),
  account_job_stop: z.object({ job_id: z.number().int().positive() }),
};

/** What a cancellation's yes is pinned to (src/tools.js confirmTargetFor). */
export const accountCancelTarget = (input, conversationId) => jobs.cancelTarget(conversationId, input.job_id);

export async function runAccountJobTool(name, input, { conversationId }) {
  const c = conversationId;
  if (!jobs.jobsAllowedFor(c)) return ACCOUNT_JOB_REFUSAL;
  switch (name) {
    case "account_cancel": return jobs.startCancel({ conversationId: c, site: input.site, plan: input.plan, name: input.name ?? "", page: input.page ?? "", sender: input.notice_from ?? "" });
    // Reached only past the gate (src/tools.js): the granted yes was for this job's open question.
    case "account_cancel_confirm": return jobs.confirmCancel({ conversationId: c, jobId: input.job_id, answers: input.answers ?? null });
    case "account_bill_pay": return jobs.startBill({ conversationId: c, site: input.site, biller: input.biller, amount: input.amount, reference: input.reference, due: input.due_date ?? "", page: input.page ?? "", sender: input.notice_from ?? "" });
    case "account_job_answer": return jobs.answerJob({ conversationId: c, jobId: input.job_id, answers: input.answers });
    case "account_job_status": { const list = jobs.statusView(c); return { ok: true, jobs: list, ...(list.length ? {} : { note: "No account job on record in the last two days. One you cannot see here did not start." }) }; }
    case "account_job_stop": return jobs.stopJob({ conversationId: c, jobId: input.job_id });
    default: return { ok: false, error: "unknown_tool" };
  }
}
