// How each service is cancelled, as a registry rather than a script. The sibling of `src/sites.js`.
//
// `src/sites.js` answers "what is this site like when you want to book something on it". This file
// answers the other question: **what does this service say about ending it**. They are deliberately
// separate files. An errand site is somewhere Reason goes to start something; these are the pages
// somebody goes to when they want to stop paying, and the pages are built differently on purpose —
// the button is three clicks deep, it is called something other than the word `cancel`, and there
// is an offer to pause instead sitting in front of it.
//
// What is in an entry, and why each part is worth having:
//
//   1. **The route.** `web` (a page Reason can drive), `email` (the service accepts a written
//      request at an address), `letter` (written notice by post, or in person), `device` (only
//      inside an app on their phone), `phone` (only by ringing them), `unknown` (nobody has read
//      it). The route decides which rail runs, and a route nobody could read is `unknown` rather
//      than a guess — see NYT below, which is exactly that case.
//   2. **The cancel page's own URL**, and `url_verified`: true only when the help page printed that
//      address itself. Several of these are the address the help page *described* rather than
//      linked, and saying which is which is the difference between Reason landing on the right page
//      and Reason landing on a 404 while telling somebody it is cancelling their subscription.
//   3. **The click path, in the service's own words**, and `commits` — the label on the last button,
//      the one that actually ends the subscription. This is the single most useful field here and
//      the hardest to get right: Netflix calls it "Finish Cancellation", Adobe calls it "Confirm
//      cancellation", YouTube calls it "Yes, cancel", and none of those is the word `confirm` that
//      the generic click guard was written for. Every one of these feeds `commitPattern()`, which
//      is folded into the browser's click guard in `src/tools.js`, so `browser_click` refuses to
//      press them and the press has to go through the gate.
//   4. **Notice rules and fees.** A gym wants eight days' warning. Adobe charges for leaving an
//      annual plan early. Both are things somebody needs told BEFORE they say yes, and neither is
//      visible on the page Reason would be standing on.
//   5. **What the confirmation is** — an email, or a date on the screen. Nothing here is recorded as
//      `cancelled` without one (`src/subscriptions.js`), so each entry has to say what to look for.
//   6. **The source: the URL, the date, and HOW it was read.** `read` means the page itself came back
//      and these words are off it. `search_snippet` means the page is drawn by JavaScript and would
//      not render for a reader, so what is here is the service's own help text as a search index
//      returned it — thinner, and flagged as such. `could_not_read` means neither worked and the
//      entry is `unknown`.
//
// **Everything below was read on 2026-10-06.** Sources, per entry, in `source.url`. A help page is
// a page: these move, and a six-month-old `commits` label is a guess with a date on it. Whoever
// re-reads them should change this file and the date in one go.
//
// What this file is NOT: a promise that any of it works. Not one of these flows has been walked for
// real — no account here has ever been cancelled, and nothing in Reason has ever pressed one of
// these buttons. `docs/unverified.md` carries that in full. The browser tests drive a fixture
// service on 127.0.0.1 that is shaped like these pages, which proves the rails and proves nothing
// about Netflix.

/**
 * The services, in the order Omari listed them.
 *
 * `label` is what Reason calls it out loud. `merchant_names` are the strings that mean this service
 * on a bank line or in a receipt's From header — used by `match()` below, which is a lookup on a
 * MERCHANT string and never a reading of anything a person said. Deciding what somebody meant is
 * the model's job (house rule); matching "NETFLIX.COM" to the Netflix entry is a lookup.
 */
export const ROUTES = [
  {
    service: "netflix",
    label: "Netflix",
    merchant_names: ["netflix"],
    route: "web",
    cancel_url: "https://www.netflix.com/cancelplan",
    // Netflix's help page links that address itself, in those words ("Manage your membership").
    url_verified: true,
    hosts: ["netflix.com"],
    signin_url: "https://www.netflix.com/login",
    account_url: "https://www.netflix.com/youraccount",
    signed_out_says: ["sign in", "sign in to netflix", "email or phone number"],
    signed_out_url: "login",
    steps: [
      "Open the Manage your membership page (it asks for a sign-in if there is not one already).",
      "Press Cancel.",
      "Under Cancel, press Finish Cancellation.",
    ],
    commit_labels: ["cancel membership", "finish cancellation"],
    commits: "Finish Cancellation",
    confirmation: "Netflix emails a confirmation to the address on the account. That email is the proof; the page saying 'cancelled' on its own is not what gets recorded.",
    notice: "",
    fees: "",
    limits: [
      "Netflix's own page says this is the ONLY way to cancel: signing out, or deleting the app, cancels nothing. Worth saying if they think they already did it.",
      "Netflix offers pausing instead. If that offer is on the screen, report it rather than clicking past it.",
    ],
    source: { url: "https://help.netflix.com/en/node/407", read_on: "2026-10-06", how: "read" },
  },
  {
    service: "spotify",
    label: "Spotify",
    merchant_names: ["spotify"],
    route: "web",
    cancel_url: "https://www.spotify.com/account/subscription/manage/",
    url_verified: true,
    hosts: ["spotify.com"],
    signin_url: "https://accounts.spotify.com/login",
    account_url: "https://www.spotify.com/account/overview/",
    signed_out_says: ["log in", "log in to spotify", "email or username"],
    signed_out_url: "accounts.spotify.com",
    steps: [
      "Open Manage your plan.",
      "Select Cancel subscription.",
    ],
    commit_labels: ["cancel subscription", "cancel premium"],
    commits: "Cancel subscription",
    confirmation: "Premium runs to the next billing date and then the account goes free; the page says which date. Read that date off the screen — it is the confirmation.",
    notice: "",
    fees: "",
    limits: [
      "Cancelling inside a zero-priced free trial drops the account to free IMMEDIATELY, not at the end of a period, and Spotify says those trials cannot be started again. Say that before asking for a yes.",
      "A plan bought through a phone or internet provider has no cancel option on this page at all — the payment section carries the provider's contact link, and that is who has to be asked.",
      "On a Family or Duo plan, only the plan manager cancels the plan; a member doing this removes themselves and the plan carries on.",
      "Spotify also documents a printed form posted to them. Not used here: a page Reason can drive is better than a form somebody has to post.",
    ],
    source: { url: "https://support.spotify.com/us/article/cancel-premium/", read_on: "2026-10-06", how: "read" },
  },
  {
    service: "hulu",
    label: "Hulu",
    merchant_names: ["hulu"],
    route: "web",
    // Described rather than linked: the help page says "your Account page" and names hulu.com/account.
    cancel_url: "https://www.hulu.com/account",
    url_verified: false,
    hosts: ["hulu.com"],
    signin_url: "https://auth.hulu.com/web/login",
    account_url: "https://www.hulu.com/account",
    signed_out_says: ["log in", "sign in", "email"],
    signed_out_url: "auth.hulu.com",
    steps: [
      "Open the Account page in a browser.",
      "Under Your Subscription, select Cancel.",
      "Follow the on-screen steps to the end.",
    ],
    commit_labels: ["cancel subscription", "cancel your subscription"],
    // Hulu's page stops at "follow the on-screen instructions", so the label on the last button is
    // NOT documented. Said out loud rather than invented: Reason reads the page and stops at
    // whatever the last button turns out to be, and the gated press covers it whatever it says.
    commits: null,
    commits_note: "Hulu does not document the label on the final button. Read it off the page and say it back before asking for a yes.",
    confirmation: "Hulu emails a confirmation once it is done.",
    notice: "",
    fees: "",
    limits: [
      "Only for an account Hulu itself bills. One billed through Apple, Google, Amazon, Roku or Disney+ cannot be cancelled here at all — it has to go through whoever takes the money, and Hulu has a separate page per biller.",
      "The help page is drawn by JavaScript and would not render for a reader, so these steps are Hulu's own help text as a search index returned it rather than read off the page.",
    ],
    source: { url: "https://help.hulu.com/article/hulu-cancel-hulu-subscription", read_on: "2026-10-06", how: "search_snippet" },
  },
  {
    service: "disney_plus",
    label: "Disney+",
    merchant_names: ["disney", "disney+", "disneyplus", "disney plus"],
    route: "web",
    cancel_url: "https://www.disneyplus.com/account/subscription",
    url_verified: false,
    hosts: ["disneyplus.com"],
    signin_url: "https://www.disneyplus.com/login",
    account_url: "https://www.disneyplus.com/account",
    signed_out_says: ["log in", "sign up", "enter your email"],
    signed_out_url: "login",
    steps: [
      "Open the Account page and go to the Subscription section.",
      "Cancel the subscription there; it ends at the end of the current term.",
    ],
    commit_labels: ["complete cancellation", "cancel subscription"],
    commits: null,
    commits_note: "Disney+ does not document the label on the final button on a page anyone could read. Read it off the page and say it back before asking.",
    confirmation: "The subscription section shows the date access ends. Read that date.",
    notice: "",
    fees: "",
    limits: [
      "Cancelling is not deleting the account, and Disney+ says so explicitly. Do not offer to delete anything.",
      "An account billed through a third party (Apple, Google, Hulu, a cable provider) is cancelled with that provider, not here.",
      "Disney's help page is drawn by JavaScript and would not render for a reader; these steps are its own help text as a search index returned it.",
    ],
    source: { url: "https://help.disneyplus.com/article/disneyplus-cancel", read_on: "2026-10-06", how: "search_snippet" },
  },
  {
    service: "max",
    label: "HBO Max",
    merchant_names: ["hbo", "hbo max", "max", "warnermedia"],
    route: "web",
    cancel_url: "https://hbomax.com/subscription",
    url_verified: true,
    hosts: ["hbomax.com", "max.com"],
    signin_url: "https://auth.hbomax.com/login",
    account_url: "https://hbomax.com/subscription",
    signed_out_says: ["sign in", "sign up"],
    signed_out_url: "auth.hbomax.com",
    steps: [
      "Open hbomax.com/subscription and sign in.",
      "Check who the subscription is billed through — it is at the top of the screen.",
      "If HBO Max bills it directly: choose Cancel Your Subscription.",
      "Confirm, and write down the expiration date it gives.",
    ],
    commit_labels: ["cancel your subscription", "cancel subscription"],
    commits: "Cancel Your Subscription",
    confirmation: "An expiration date on the screen, which their page tells people to note down. That date is the confirmation.",
    notice: "",
    fees: "",
    limits: [
      "The first real step is finding out WHO bills it. Apple, Google Play, Roku, Amazon and cable providers all bill HBO Max subscriptions, and none of those can be cancelled on hbomax.com.",
      "Their page says to confirm the cancellation but does not print the label on the confirm button, so read it off the page.",
    ],
    source: { url: "https://help.hbomax.com/us/Answer/Detail/000002526", read_on: "2026-10-06", how: "read" },
  },
  {
    service: "apple",
    label: "Apple subscriptions (App Store)",
    merchant_names: ["apple", "apple.com/bill", "itunes", "app store", "apple services"],
    // Apple documents BOTH a web page and a path inside Settings. The route is recorded as `device`
    // anyway, and that is a judgement worth being explicit about: the web page is real, but it is
    // behind an Apple Account sign-in with two-factor on a trusted device, and Reason has no way to
    // complete one. Recording `web` would be true about Apple and false about what Reason can do.
    route: "device",
    cancel_url: "https://account.apple.com/account/manage/section/subscriptions",
    url_verified: true,
    hosts: ["apple.com"],
    steps: [
      "On their iPhone or iPad: Settings, tap their name, tap Subscriptions, tap the subscription, tap Cancel Subscription.",
      "On a Mac: App Store, their name, Subscriptions, the subscription, Cancel Subscription.",
      "On the web: account.apple.com subscriptions — which needs an Apple Account sign-in with two-factor.",
    ],
    commit_labels: ["cancel subscription"],
    commits: "Cancel Subscription",
    confirmation: "The subscription shows an expiration message in red, or the Cancel button is gone. Apple also emails receipts.",
    notice: "A trial has to be cancelled at least 24 hours before it ends.",
    fees: "",
    limits: [
      "Reason cannot tap their phone. This one is theirs to do, and the honest answer is the Settings path said back in four short steps, not an offer to do it.",
      "Apple's web page needs two-factor on a trusted device, so Reason cannot drive it either.",
      "A subscription on a family member's Apple Account can only be cancelled by that person. Apple's own trick for finding out whose it is: search the mail for 'receipt from Apple' and read which account is on the receipt — which is something Reason CAN do.",
    ],
    source: { url: "https://support.apple.com/en-us/118428", read_on: "2026-10-06", how: "read" },
  },
  {
    service: "google_play",
    label: "Google Play",
    merchant_names: ["google play", "google", "play store"],
    route: "web",
    cancel_url: "https://play.google.com/store/account/subscriptions",
    url_verified: true,
    hosts: ["play.google.com"],
    signin_url: "https://accounts.google.com",
    account_url: "https://play.google.com/store/account/subscriptions",
    signed_out_says: ["sign in", "sign in to continue"],
    signed_out_url: "accounts.google.com",
    steps: [
      "Open subscriptions in Google Play, signed in to the account that has them.",
      "Click Manage on the subscription.",
      "Click Cancel subscription.",
      "In the pop-up, pick a reason.",
      "Click Continue.",
    ],
    // "Continue" is the last press and it is deliberately NOT in commit_labels: see commitPattern(),
    // which drops one-word generic labels. A guard that treated every "Continue" on the web as a
    // commit would spend somebody's yes on turning a page. The last press is gated regardless,
    // because `subscription_cancel_commit` always needs one.
    commit_labels: ["cancel subscription"],
    commits: "Continue",
    commits_note: "The last press is a plain 'Continue' inside the cancellation pop-up. It is not in the guard's word list — a 'Continue' anywhere on the web would be — so it has to go through subscription_cancel_commit, which needs a yes whatever the button says.",
    confirmation: "The subscription is listed as cancelled with the date access runs to.",
    notice: "",
    fees: "",
    limits: [
      "Uninstalling the app cancels nothing, which Google says in bold. Worth saying.",
      "A prepaid plan needs no cancelling — it expires on its own.",
      "On a payment plan, the remaining payments cannot be cancelled; only the auto-renewal can be stopped, and they still owe the rest. Say that before asking for a yes.",
    ],
    source: { url: "https://support.google.com/googleplay/answer/7018481", read_on: "2026-10-06", how: "read" },
  },
  {
    service: "amazon_prime",
    label: "Amazon Prime",
    merchant_names: ["amazon prime", "prime membership", "amazon.com prime"],
    route: "web",
    cancel_url: "https://www.amazon.com/gp/primecentral",
    url_verified: false,
    hosts: ["amazon.com"],
    signin_url: "https://www.amazon.com/gp/css/order-history",
    account_url: "https://www.amazon.com/gp/primecentral",
    signed_out_says: ["sign in", "email or mobile phone number"],
    signed_out_url: "/ap/signin",
    steps: [
      "Open Manage Prime Membership.",
      "Choose Update, cancel, and more.",
      "Choose Cancel Membership — forgo benefits.",
      "Or, from Your Memberships and Subscriptions: Manage Subscription, then Cancel Subscription under Advanced Controls.",
    ],
    commit_labels: ["cancel membership", "end membership", "cancel subscription"],
    commits: "Cancel Membership - forgo benefits",
    confirmation: "The membership page shows the benefits end date, and Amazon emails about it.",
    notice: "",
    fees: "",
    limits: [
      "Amazon's own help pages for this answered a reader with a 404 and a 503, so the steps here are Amazon's help text as a search index returned it. The page address is the one described rather than one printed, which is why url_verified is false — check the page is the right one before touching anything.",
      "A paid member who has used no benefits may be due a refund of the current period. Amazon decides that, not Reason: never promise one.",
      "Prime is bundled into other things (Prime Video on its own, a Young Adult plan, a business account) and each has a different page.",
    ],
    source: { url: "https://www.amazon.com/gp/help/customer/display.html?nodeId=TvpAfjoQat32uK1VwP", read_on: "2026-10-06", how: "search_snippet" },
  },
  {
    service: "youtube_premium",
    label: "YouTube Premium",
    merchant_names: ["youtube premium", "youtubepremium", "google *youtube"],
    route: "web",
    cancel_url: "https://www.youtube.com/paid_memberships",
    url_verified: true,
    hosts: ["youtube.com"],
    signin_url: "https://accounts.google.com",
    account_url: "https://www.youtube.com/paid_memberships",
    signed_out_says: ["sign in", "sign in to youtube"],
    signed_out_url: "accounts.google.com",
    steps: [
      "Open the paid memberships page.",
      "Pick the membership.",
      "Press Continue to cancel.",
      "Pick a reason and press Next.",
      "Press Yes, cancel.",
    ],
    commit_labels: ["yes, cancel", "cancel membership"],
    commits: "Yes, cancel",
    confirmation: "The membership page shows benefits running to the end of the billing period.",
    notice: "",
    fees: "",
    limits: [
      "A Premium bought through Apple or a carrier is not cancelled here.",
    ],
    source: { url: "https://support.google.com/youtube/answer/6308278", read_on: "2026-10-06", how: "read" },
  },
  {
    service: "nytimes",
    label: "The New York Times",
    merchant_names: ["new york times", "nytimes", "nyt"],
    // The honest entry. help.nytimes.com redirects a reader to its own front page and draws every
    // article with JavaScript, and a search for the cancellation article came back with no links at
    // all — so nobody here has read what the Times says about cancelling. It is widely said to need
    // a chat or a phone call, and that is exactly the kind of thing this file must not record on
    // hearsay. `unknown` is the answer, and Reason says it will open the account page WITH them.
    route: "unknown",
    cancel_url: "",
    url_verified: false,
    hosts: ["nytimes.com"],
    account_url: "https://www.nytimes.com/account",
    steps: [],
    commit_labels: [],
    commits: null,
    confirmation: "",
    notice: "",
    fees: "",
    limits: [
      "Nobody has read the Times's own cancellation page: help.nytimes.com bounced a reader to its front page and a search for the article returned nothing. So there is no route recorded, and none is guessed at.",
      "It is commonly said to need a chat or a phone call. That is hearsay and Reason does not say it as fact — it says it does not know yet and offers to open the account page with them and read what is actually there.",
    ],
    source: { url: "https://help.nytimes.com/hc/en-us/articles/115014893967", read_on: "2026-10-06", how: "could_not_read" },
  },
  {
    service: "planet_fitness",
    label: "Planet Fitness",
    merchant_names: ["planet fitness", "planetfitness", "pf black card"],
    // Written notice, which is why this entry carries the email rail's shape. There is no one
    // address: notice goes to the member's OWN home club, so `cancel_email` is empty and the
    // address has to come from them or from the club's page. That is recorded rather than filled in
    // with something plausible.
    route: "letter",
    accepts_written_notice: true,
    cancel_email: "",
    cancel_url: "",
    url_verified: false,
    hosts: ["planetfitness.com"],
    account_url: "https://www.planetfitness.com/account",
    steps: [
      "Written notice by post to their own home club, or in person at that club.",
      "Some clubs also take it through the member portal on the website.",
    ],
    commit_labels: ["cancel membership"],
    commits: null,
    confirmation: "A reply from the club confirming the membership is ended. Without one this stays 'cancelling'.",
    notice: "The club has to RECEIVE the notice at least 8 days before the next billing date, because a billing change can take up to 7 days to take effect. The annual fee has its own date and the same 8 days.",
    fees: "A membership with a minimum term ended early needs a $58 buyout.",
    limits: [
      "This is the one on the list that is genuinely not a web flow. Reason can write the notice — and send it by email if they have an address for their club — but it does not arrive by Reason pressing anything.",
      "Policies vary by club and by state, so the club's own answer beats this entry.",
      "The customer-service page refused a reader (403, a bot check), so this is Planet Fitness's own help text as a search index returned it.",
    ],
    source: { url: "https://www.planetfitness.com/about-planet-fitness/customer-service/", read_on: "2026-10-06", how: "search_snippet" },
  },
  {
    service: "adobe",
    label: "Adobe",
    merchant_names: ["adobe", "adobe creative cloud", "adobe systems"],
    route: "web",
    cancel_url: "https://account.adobe.com/plans",
    url_verified: true,
    hosts: ["adobe.com"],
    signin_url: "https://account.adobe.com",
    account_url: "https://account.adobe.com/plans",
    signed_out_says: ["sign in", "email address"],
    signed_out_url: "auth.services.adobe.com",
    steps: [
      "Open the Adobe account's Plans page.",
      "In Plans and payment, select Manage plan.",
      "Select Cancel your plan.",
      "Check the plan details, then select Continue to cancel.",
      "Pick a reason, then select Continue.",
      "Review the cancellation details, then select Confirm cancellation.",
    ],
    commit_labels: ["confirm cancellation", "continue to cancel", "cancel your plan"],
    commits: "Confirm cancellation",
    confirmation: "The plan shows as cancelled on the Plans page, with access running to the end of the billing period.",
    notice: "",
    // The number is the thing to be careful about. Adobe's page says a refund depends on when you
    // cancel and that most plans get a full refund inside 14 days; the early-termination charge for
    // leaving an annual plan is in their subscription terms and the amount is NOT on this page. So
    // the amount is read off the review screen at the last step and never quoted from here.
    fees: "A refund depends on when they cancel; Adobe's page says most plans get a full refund within 14 days of purchase. Leaving an annual plan early carries a charge whose amount is in Adobe's subscription terms and is NOT on the help page — read the number off the review screen before asking for a yes, and never quote one from memory.",
    limits: [
      "Several plans on one account cancel one at a time. Cancelling one leaves the others running, and Adobe says so.",
      "The review screen before the last button is where the fee appears. That screen is the one to read back.",
      "A plan bought through Apple, Google or Microsoft is cancelled with them instead.",
    ],
    source: { url: "https://helpx.adobe.com/account/individual/subscriptions-and-plans/renewals-and-cancellations/cancel-adobe-subscription.html", read_on: "2026-10-06", how: "read" },
  },
  {
    service: "peloton",
    label: "Peloton",
    merchant_names: ["peloton", "onepeloton"],
    route: "web",
    cancel_url: "https://www.onepeloton.com/mymembership",
    url_verified: true,
    hosts: ["onepeloton.com"],
    signin_url: "https://members.onepeloton.com/login",
    account_url: "https://www.onepeloton.com/mymembership",
    signed_out_says: ["log in", "sign up", "email"],
    signed_out_url: "login",
    steps: [
      "Open the membership page.",
      "Click Manage next to the subscription.",
      "Click Pause or cancel, and choose.",
    ],
    commit_labels: ["cancel membership", "pause or cancel"],
    commits: null,
    commits_note: "Peloton documents the path as far as 'Pause or cancel' and no further. Read the last button off the page.",
    confirmation: "Access runs to the end of the current billing period and the membership then cancels rather than renews; the page shows that date.",
    notice: "",
    fees: "",
    limits: [
      "Pause and cancel are the same menu item, so the choice between them is on the screen and should be put to them rather than assumed.",
      "An All-Access membership and an App membership are different subscriptions with different pages.",
      "The support page is drawn by JavaScript; these steps are Peloton's own help text as a search index returned it.",
    ],
    source: { url: "https://support.onepeloton.com/s/article/Peloton-Membership-How-to-Manage-Your-All-Access-Membership", read_on: "2026-10-06", how: "search_snippet" },
  },
  {
    service: "audible",
    label: "Audible",
    merchant_names: ["audible"],
    route: "web",
    cancel_url: "https://www.audible.com/account/membership",
    url_verified: false,
    hosts: ["audible.com"],
    signin_url: "https://www.audible.com/signin",
    account_url: "https://www.audible.com/account/membership",
    signed_out_says: ["sign in", "email or mobile phone number"],
    signed_out_url: "signin",
    steps: [
      "On the Audible site, select their name in the top navigation.",
      "Select Membership details.",
      "Select the Cancel membership link.",
      "Select Confirm cancellation.",
    ],
    commit_labels: ["confirm cancellation", "cancel membership"],
    commits: "Confirm cancellation",
    confirmation: "Audible emails a confirmation, and the Membership details page shows the change.",
    notice: "",
    fees: "",
    limits: [
      "At the end of the final billing cycle, unused credits are LOST along with member discounts. Titles already bought stay. Say that before asking — it is the thing people are upset about afterwards.",
      "A membership billed through Apple or Google cannot be cancelled on Audible's site at all.",
      "The page address is the one described rather than one printed, so check the page before touching anything.",
    ],
    source: { url: "https://help.audible.com/s/article/cancel-membership", read_on: "2026-10-06", how: "search_snippet" },
  },
  {
    service: "chatgpt_plus",
    label: "ChatGPT Plus",
    merchant_names: ["openai", "chatgpt", "chatgpt plus"],
    route: "web",
    cancel_url: "https://chatgpt.com/#settings/Account",
    url_verified: false,
    hosts: ["chatgpt.com", "openai.com"],
    signin_url: "https://auth.openai.com/log-in",
    account_url: "https://chatgpt.com",
    signed_out_says: ["log in", "sign up"],
    signed_out_url: "auth.openai.com",
    steps: [
      "Signed in on chatgpt.com, open the account menu and choose Settings.",
      "Choose Billing.",
      "Under Cancel plan, choose Cancel.",
    ],
    commit_labels: ["cancel plan", "cancel subscription"],
    commits: "Cancel",
    commits_note: "The last press is a plain 'Cancel' inside a section headed 'Cancel plan'. A bare 'Cancel' is not in the guard's word list for the same reason 'Continue' is not; the press is gated through subscription_cancel_commit instead.",
    confirmation: "Paid features run to the end of the current billing period; the billing page says which date.",
    notice: "Cancel at least 24 hours before the next billing date to avoid the next period's charge.",
    fees: "",
    limits: [
      "A subscription bought in the iOS or Android app is billed by Apple or Google and is cancelled there, not here.",
      "Deleting the account is a different thing and is not needed to stop the charges. Do not offer it.",
      "Settings opens as a panel rather than its own address, so the page address here is not one OpenAI prints. Open chatgpt.com and walk the menu instead of trusting the URL.",
    ],
    source: { url: "https://help.openai.com/en/articles/7232927-how-do-i-cancel-my-chatgpt-plus-subscription", read_on: "2026-10-06", how: "search_snippet" },
  },
  {
    service: "claude",
    label: "Claude (Anthropic)",
    merchant_names: ["anthropic", "claude", "claude pro", "claude max", "claude.ai"],
    route: "web",
    cancel_url: "https://claude.ai/settings/billing",
    url_verified: false,
    hosts: ["claude.ai"],
    signin_url: "https://claude.ai/login",
    account_url: "https://claude.ai",
    signed_out_says: ["log in", "sign in", "get started"],
    signed_out_url: "claude.ai/login",
    steps: [
      "Signed in on claude.ai, open Settings from the menu.",
      "Choose Billing.",
      "Under the current plan, choose the option to cancel or downgrade.",
    ],
    commit_labels: ["cancel plan", "cancel subscription", "downgrade"],
    commits: "Cancel",
    commits_note: "The billing page shows the current plan with an option to cancel or downgrade. The exact label may vary between Pro and Max tiers.",
    confirmation: "Paid features run to the end of the current billing period.",
    notice: "",
    fees: "",
    limits: [
      "A subscription bought through the iOS app is billed by Apple and is cancelled there, not on claude.ai.",
      "Claude Pro and Claude Max are different tiers on the same billing page.",
    ],
    source: { url: "https://claude.ai/settings/billing", read_on: "2026-10-06", how: "search_snippet" },
  },
];

const BY_SERVICE = new Map(ROUTES.map(r => [r.service, r]));

/** Every route kind that exists, so a caller cannot invent a sixteenth. */
export const ROUTE_KINDS = ["web", "email", "letter", "device", "phone", "unknown"];

export function routeNames() {
  return ROUTES.map(r => r.service);
}

export function route(name) {
  return BY_SERVICE.get(String(name ?? "").trim().toLowerCase()) ?? null;
}

/**
 * Which registry entry a MERCHANT string is about, or null.
 *
 * A lookup on the name of a business, not a reading of anything a person said. The house rule is
 * that the model decides what somebody meant and what counts as a subscription; matching the string
 * "NETFLIX.COM 866-579-7172" to the Netflix entry is the other kind of work entirely, and leaving it
 * to the model would mean the model guessing a cancel URL — which is the thing this file exists to
 * stop.
 *
 * Longest name first, so "amazon prime" wins over "amazon" and "hbo max" over "max".
 */
export function match(merchant) {
  const hay = String(merchant ?? "").toLowerCase();
  if (!hay.trim()) return null;
  let best = null;
  for (const r of ROUTES) {
    for (const name of r.merchant_names) {
      if (!hay.includes(name)) continue;
      if (!best || name.length > best.len) best = { entry: r, len: name.length };
    }
  }
  return best?.entry ?? null;
}

/**
 * One-word labels that never go into the click guard, however a service uses them.
 *
 * Google Play's last press is "Continue" and ChatGPT's is "Cancel". Both really do commit, in their
 * own pop-up — and both are on a hundred million pages where they commit nothing. A guard that
 * treated every "Continue" as irreversible would refuse to turn a page and would spend somebody's
 * yes on navigation, which is the exact failure the guard in `src/tools.js` was rewritten to avoid.
 *
 * Nothing is lost by leaving them out: the press that ends a subscription goes through
 * `subscription_cancel_commit`, which needs an explicit yes whatever the button is called.
 */
const TOO_GENERIC = new Set(["continue", "cancel", "next", "done", "yes", "ok", "confirm", "submit"]);

/**
 * Labels that are not off any one service's page: the phrasings a retention flow puts in front of
 * the real button.
 *
 * Every other string in this file came off a help page, and this list did not — it is a widening of
 * a GUARD rather than a claim about a route, and the two are different things. The reason it is here:
 * four of the fifteen entries above do not document the label on their last button, so a flow can
 * end on a button nobody has written down. An unrecognised cancel button that `browser_click` presses
 * unasked is the failure that costs somebody their subscription without being asked; a recognised
 * one that turns out to commit nothing costs one extra question. Failing closed is the right
 * direction, and this is said out loud here and in `docs/unverified.md` rather than hidden.
 */
const COMMON_CANCEL_COMMITS = [
  "finish cancellation",
  "complete cancellation",
  "confirm cancellation",
  "cancel membership",
  "cancel subscription",
  "cancel my subscription",
  "cancel your subscription",
  "cancel plan",
  "cancel your plan",
  "end membership",
  "end my membership",
  "end subscription",
  "continue to cancel",
  "yes, cancel",
  "cancel anyway",
];

/**
 * Every cancel-commit label as one pattern for the click guard, the way `sites.commitPattern()`
 * does it for the errand sites. Built once at load; the registry does not change at runtime.
 */
export function commitPattern() {
  const labels = [...new Set([
    ...ROUTES.flatMap(r => r.commit_labels ?? []),
    ...COMMON_CANCEL_COMMITS,
  ])]
    .map(l => String(l).trim().toLowerCase())
    .filter(l => l && !TOO_GENERIC.has(l))
    .sort((a, b) => b.length - a.length)
    .map(l => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  return new RegExp(`\\b(${labels.join("|")})\\b`, "i");
}

/** Every label in the guard, for a test that wants to check one is in there. */
export function commitWords() {
  return [...new Set([
    ...ROUTES.flatMap(r => r.commit_labels ?? []),
    ...COMMON_CANCEL_COMMITS,
  ])].map(l => String(l).trim().toLowerCase()).filter(l => l && !TOO_GENERIC.has(l));
}

/**
 * A sites.js-shaped entry, so a web-route service can use the sign-in machinery that already exists.
 *
 * The saved sign-ins, the phone sign-in link and the "is this signed in" probe are all written
 * against the shape in `src/sites.js` — `site`, `label`, `signin_url`, `hosts`, and a `signed_in`
 * spec. Rather than copy any of that, a service here is handed back in that shape and the existing
 * code works on it unchanged (`src/signin.js` resolves a name through both registries).
 *
 * `when_in` is empty on every one of them, on purpose and for the same reason sites.js leaves it
 * empty: nobody here has loaded a signed-in page on any of these services, so there is nothing
 * positive to test for, and inventing one is how a probe reports "signed in" for a stranger.
 * Signed-OUT is what can be proved, and `signed_out_says` is written from what these sites put on a
 * signed-out page.
 *
 * Returns null for a service with no web route: there is nothing to sign in to.
 */
export function signinEntry(name) {
  return signinEntryFrom(route(name));
}

function signinEntryFrom(r) {
  if (!r || r.route !== "web") return null;
  if (!r.signin_url || !r.account_url) return null;
  return {
    site: r.service,
    label: r.label,
    what: `see and cancel their ${r.label} subscription`,
    hosts: r.hosts ?? [],
    entry: r.account_url,
    signin_url: r.signin_url,
    urls_verified: !!r.url_verified,
    needs_signin: "always",
    signed_in: {
      url: r.account_url,
      when_in: [],
      when_out: r.signed_out_says ?? ["sign in", "log in"],
      when_out_url: r.signed_out_url ?? "",
    },
    commit_labels: r.commit_labels ?? [],
    limits: r.limits ?? [],
    // So anything reading an entry can tell these apart from the ten errand sites without guessing
    // from the name.
    from_cancel_routes: true,
  };
}

/**
 * The same four lookups, over this registry plus some extra entries.
 *
 * This exists for one reason and it is the same reason `sites.siteFor(url, extraHosts)` takes a
 * second argument: an offline test has to be able to stand a service up on 127.0.0.1 and have the
 * real rails run against it. Nothing about cancelling a subscription can be proven against Netflix
 * — no account here has ever been cancelled and nothing in Reason has ever pressed one of those
 * buttons — so the only honest way to test the web rail end to end is a fixture shaped like these
 * pages, with its own entry resolved exactly as a real one is.
 *
 * Production passes nothing and never calls this: the tools reach for `ctx.cancelRoutes` and fall
 * back to this module, so a real conversation can only ever see the fifteen entries above.
 */
export function withExtra(extra = []) {
  const map = new Map([...BY_SERVICE, ...extra.map(e => [e.service, e])]);
  const all = [...ROUTES, ...extra];
  const self = {
    ROUTES: all,
    routeNames: () => all.map(r => r.service),
    route: (name) => map.get(String(name ?? "").trim().toLowerCase()) ?? null,
    match: (merchant) => {
      const hay = String(merchant ?? "").toLowerCase();
      if (!hay.trim()) return null;
      let best = null;
      for (const r of all) {
        for (const name of r.merchant_names ?? []) {
          if (!hay.includes(name)) continue;
          if (!best || name.length > best.len) best = { entry: r, len: name.length };
        }
      }
      return best?.entry ?? null;
    },
    signinEntry: (name) => signinEntryFrom(self.route(name)),
    playbook: (name) => playbookFrom(self.route(name)),
    cannotDo,
    commitPattern,
    commitWords,
  };
  return self;
}

/** What the model is told about one service. The internals of the source record stay here. */
export function playbook(name) {
  return playbookFrom(route(name));
}

function playbookFrom(r) {
  if (!r) return null;
  return {
    service: r.service,
    label: r.label,
    route: r.route,
    ...(r.route === "web" ? { cancel_page: r.cancel_url, cancel_page_address_verified: !!r.url_verified } : {}),
    ...(r.cancel_email ? { cancel_email: r.cancel_email } : {}),
    ...(r.accepts_written_notice ? { accepts_written_notice: true } : {}),
    steps: r.steps ?? [],
    the_button_that_commits: r.commits,
    ...(r.commits_note ? { about_that_button: r.commits_note } : {}),
    ...(r.commits ? {} : { no_documented_button: "This service does not publish the label on its last button. Read the page, say back what the button says, and ask for a yes on that." } ),
    what_counts_as_confirmation: r.confirmation,
    ...(r.notice ? { notice_rules: r.notice } : {}),
    ...(r.fees ? { fees: r.fees } : {}),
    limits: r.limits ?? [],
    read_from: `${r.source.url} on ${r.source.read_on} (${r.source.how === "read" ? "the page itself" : r.source.how === "search_snippet" ? "the service's own help text through a search index; the page is drawn by JavaScript and would not render for a reader" : "could not be read at all"})`,
  };
}

/**
 * The honest answer for a route Reason cannot take, per kind.
 *
 * Returned by the tool rather than left for the model to improvise, because these are the four
 * places where the temptation is to offer a workaround and there is not one. The phone line names
 * the build that would change it (the calls work, 2026-10-09) and promises nothing
 * before then.
 */
export function cannotDo(kind, label) {
  const who = label || "this one";
  switch (kind) {
    case "phone":
      return {
        kind: "phone",
        say: `${who} only cancels over the phone, and I can't make calls yet. Once calling is on I'll ring them and sit through the hold for you — want me to keep it on the list for then?`,
        why: "Reason has no phone rail yet. The calls build is separate and is not finished.",
        when: "Calls are being built. Nothing here can dial today, so do not say it will try.",
      };
    case "device":
      return {
        kind: "device",
        say: `${who} is cancelled on your phone and I can't tap your phone. I'll walk you through it — it's four taps.`,
        why: "An App Store subscription lives behind Settings on the person's own device, and Apple's web page needs two-factor on a trusted device.",
        when: "There is no build that changes this. Say the steps and stop.",
      };
    case "letter":
      return {
        kind: "letter",
        say: `${who} wants it in writing. I can write the notice and send it from your email if you've got an address for them, or you can print it — but nothing gets cancelled by me pressing a button here.`,
        why: "Written notice by post or in person, which no browser can do.",
        when: "Reason can draft the notice and send it as email through the gate when there is an address.",
      };
    default:
      return {
        kind: "unknown",
        say: `I don't actually know how ${who} wants this done — nobody's read their page. Want me to open your account page with you and read what's there?`,
        why: "No route is recorded for this service, and a guess at one is worse than not knowing.",
        when: "Reading the service's own page with them is the real next step.",
      };
  }
}
