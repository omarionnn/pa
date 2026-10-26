// The two pages Google needs before a consent screen can be published: a home page and a privacy
// policy, both at a plain address anybody can open without a link or a code.
//
// Everything on the privacy page is written off the code rather than off intention, because a privacy
// policy is the one document where being approximately right is being wrong. Where it says what is
// stored, that list is `TABLES` in src/data.js and the schema in src/db.js. Where it says what leaves
// the machine, that is what `src/agent.js` sends to the model and what the provider modules send to
// their providers. Two things on it are the kind of thing people assume are not true, so they are
// said plainly and first:
//
//   1. **Email text is kept in the conversation transcript.** `conversations.messages` holds the last
//      60 messages of a thread, tool results included (`saveThread` / `THREAD_KEEP` in
//      src/thread.js, on both backends — the CLI path kept everything until 2026-10-18, so until
//      then this was only true of the API path). So an email Reason read is on the disk until it
//      falls out of that window.
//   2. **Email text is sent to Anthropic**, because that is how the model reads it. There is no
//      on-device model. Under Google's Limited Use rules this is the permitted kind of transfer — it
//      is what provides the feature the person asked for — but it is a transfer, and a policy that
//      did not mention it would be false.
//
// Anything here that could not be checked against the code is NOT on the page. Omari reads it before
// it is used.
import { renderNotice } from "./render.js";
import { config } from "../config.js";

/** Where this install is reachable, for the page to name its own address honestly. */
const where = () => config.publicUrl || `http://127.0.0.1:${config.port}`;

/**
 * The Search Console meta tag, when this install has been given one. Google's brand verification
 * asks the project owner to prove the home page's domain; the meta-tag method is this one line on the
 * home page. config.js keeps only token characters, so it is safe to drop into the head as is.
 */
const verificationTag = () => (config.googleSiteVerification
  ? `<meta name="google-site-verification" content="${config.googleSiteVerification}">`
  : "");

/** The terms are a real link on every public page too; Google's reviewer looks for them next to the policy. */
const policyLinks = () => [
  { label: "Privacy policy", href: "/privacy", note: "What is kept, what leaves the machine, and how to disconnect." },
  { label: "Terms of service", href: "/terms", note: "What Reason is, what it promises, and what it does not." },
];

export function homePage() {
  return renderNotice({
    title: "Reason",
    kicker: "Your personal concierge",
    lines: [
      "Reason is an assistant you text like a friend. You ask it for things in plain words — look this up, remind me, sort this out, what's on Thursday — and it does them, keeps track of what is still open, and comes back when there is something real to say.",
      "It is one person's assistant at a time. Everyone who texts it gets their own: their own memory, their own connected accounts, their own history. Nobody can see anybody else's.",
      "It only connects to something when you connect it yourself. If you want it to work with your email, your calendar or your Drive, you ask, it sends you a link, and you agree on Google's own page. Each of those is its own permission and its own tap — connecting your email does not give it your files. It never asks for a password, for anything.",
      "Anything that spends money or reaches another person stops and asks you first, and shows you exactly what it is about to do. A yes covers that one thing.",
      "It is free software, MIT licensed, and the whole of it can be read: github.com/omarionnn/pa",
    ],
    sections: [
      {
        title: "Your data is yours",
        lines: [
          "Everything Reason knows about you is in one database on the machine it runs on. You can have all of it, or have it all deleted, whenever you ask.",
          "The privacy policy says exactly what is kept, what leaves the machine, and how to disconnect: /privacy",
        ],
      },
    ],
    meta: where(),
    indexable: true,
    head: verificationTag(),
    // The privacy policy and the terms are real links here, and so is the fuller website when this
    // install has one (REASON_SITE_URL). This page is the plain one on purpose; the line says so.
    links: [
      ...policyLinks(),
      ...(config.siteUrl
        ? [{ label: "See the good-looking version", href: config.siteUrl, note: "This page wore a suit for the paperwork. The fun one is over here." }]
        : []),
    ],
  });
}

export function privacyPage() {
  return renderNotice({
    title: "Privacy",
    kicker: "What Reason keeps, and what it does not",
    meta: `Reason at ${where()} · last changed 2026-10-05`,
    indexable: true,
    head: verificationTag(),
    links: [{ label: "Terms of service", href: "/terms" }, { label: "Home", href: "/" }],
    lines: [
      "Reason is a personal assistant you text. This explains what it stores, what leaves the machine it runs on, and how to get rid of all of it. It is written against the code, which is public: github.com/omarionnn/pa",
    ],
    sections: [
      {
        title: "What Reason stores",
        lines: [
          "One database file on the machine Reason runs on. There is no other copy, no analytics service and no third-party storage. Everything in it is keyed to your conversation, and no query in the code can read one person's rows from another person's conversation.",
          "Your messages to Reason and its replies to you, as a running transcript. The transcript keeps the most recent 60 messages of your thread and older ones fall off it.",
          "What the transcript holds is worth being plain about: it includes the results of things Reason looked up for you. So if Reason read an email or an event for you, the text of that email or event is in the transcript on the disk until it falls out of those 60 messages. It is not stored anywhere else, it is not indexed, and nothing goes looking through it.",
          "Plans, reminders, timers and the jobs Reason is working on between messages. Facts you have asked it to remember about people. Pages it made for you, and any answers you tapped on one.",
          "A receipt for every action that touched the outside world — what it did, when, whether it worked — so that \"what did you do today\" is answered from a record rather than from memory. Every time it asked you for permission, and what you said.",
          "Which accounts you have connected, and the tokens that make them work. Phone calls it placed for you, with their recordings as files on the same machine. A count of how many turns and calls you used each day, and what has been committed in spending.",
        ],
      },
      {
        title: "Your Google data in particular",
        lines: [
          "Reason asks for five Google permissions in total and no others. Asking for your email and calendar asks for three of them: Gmail (read, search, draft, send, label, archive, and move to the bin), Calendar events (see, add, change and remove events), and reading a calendar's settings (its name and time zone, so times are written in your zone). It deliberately cannot delete your mail permanently, because the permission that would allow that is not one it asks for; and it cannot create, share or delete a calendar, for the same reason.",
          "Your Drive is the other two, and it is a separate tap: connecting your email does not connect your files, and Reason will send you a second link the first time you ask it for something in your Drive. One permission lets it find and read your files; the other lets it make a new Google Doc when you ask for one, and covers nothing but the documents it made itself. It cannot delete, share, rename, move or edit anything in your Drive — those permissions are not ones it asks for, so ask it to change a document and it will tell you it cannot and offer to make you a new one. Adding a permission never takes away one you already gave.",
          "Reason uses your Gmail, Calendar and Drive data only to do the thing you asked for in the conversation you asked in. Nothing else reads it. It is never sold, never shared with a data broker, never used for advertising of any kind, and never used to train or improve any model.",
          "It does not copy your mailbox or your Drive. It asks Google for what it needs when you ask a question, and what comes back lives in your transcript as described above until it falls off it. There is no index, no second copy and no background scanning: a file is read when you ask about it and not before.",
          "A PDF — in your Drive, or attached to an email — can be read, and this is the part worth being exact about. Reading an email does not download what is attached to it; the bytes are only fetched when you ask about that particular file. The text is then pulled out on the machine Reason runs on, by the PDF reader macOS already has. The document is not sent to any model, any service or anybody else to be read, and it is not kept: the bytes are written to a temporary file for as long as the reading takes and deleted straight afterwards. What stays is the text that came out, in your transcript, exactly like the text of an email or a Google Doc, until it falls off those 60 messages — and a disconnect clears it along with everything else Reason read out of your account. A PDF that is a scan has no text in it to pull out, and Reason tells you that rather than sending it somewhere that could guess.",
          "No access token or refresh token ever leaves the machine. They are not in an export, not in a receipt, and not written to a log. Nor are the contents of a document it made for you: the receipt says which document and where it is, and the document itself is in your Drive.",
          "Anything inside an email, a calendar invite or a document is treated as information and never as an instruction. A file or an email that tells Reason to forward itself, or to reply with a code, gets reported to you, naming it. It cannot make Reason act: the permission gate reads your own replies in your own conversation, and a document is not one of those.",
        ],
      },
      {
        title: "Limited Use",
        lines: [
          "Reason's use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.",
          "In plain words, what that commits to here: the data is used only to provide the features you can see in your own conversation; it is not transferred to anyone except as needed to provide those features to you, for security, or where the law requires it; it is not sold or used for advertising; and no human reads it except where you have asked for something specific, or where it is necessary to investigate a bug or abuse, or where the law requires it.",
        ],
      },
      {
        title: "What leaves the machine, and why",
        lines: [
          "To answer you at all, Reason sends your conversation to Anthropic's API, because that is the model that reads it and writes the reply. There is no model on the machine. That means the part of your conversation still in the transcript — including text from an email or an event Reason read for you — is sent to Anthropic as part of producing your answer. Anthropic's own terms govern what they do with it.",
          "When you ask Reason to do something with a service, it talks to that service: Google for your mail, calendar and Drive, and whichever of a search provider, a telephony provider or a payments provider is set up on this install. It sends what the request needs and nothing more.",
          "That is the whole list. Nothing is sent anywhere for analytics, advertising, or model training.",
        ],
      },
      {
        title: "Disconnecting",
        lines: [
          "Text Reason and ask it to disconnect your Google, or to stop reading your email. It revokes the connection at Google and deletes the stored tokens from the machine — one grant covers your mail, your calendar and your Drive, so disconnecting takes all of it. If Google will not confirm the revoke, Reason tells you so rather than claiming it is done.",
          "You can also take it away from your own side at any time, whatever Reason does: myaccount.google.com/permissions lists every app with access to your Google account, Reason included, and removing it there cuts it off immediately.",
          "Disconnecting stops Reason reaching your account. It does not by itself clear what is already in your transcript — ask for a delete for that.",
        ],
      },
      {
        title: "Getting it all, or getting rid of it",
        lines: [
          "Ask Reason and it will tell you. If you run this install yourself, two commands do it: `npm run data:export` writes out everything held about you, including the call recordings, with the tokens replaced by a marker because those are live credentials rather than your records. `npm run data:delete` removes it.",
          "A delete is real and immediate. It removes the rows, the call recordings as files from the disk, and the saved browser logins, and it asks Google to let go of your connection on the way through — and reports honestly if Google would not.",
          "Reason has no backups. There is nothing to recover from and nothing to ask anybody else to delete.",
        ],
      },
      {
        title: "Children",
        lines: [
          "Reason is not for anybody under 13 and is not directed at children.",
        ],
      },
      {
        title: "Changes, and who to ask",
        lines: [
          "If what Reason does with your data changes, this page changes with it, and the date at the top moves.",
          "This is one person's assistant, run by the person who gave you the number. Ask them, or read the code: github.com/omarionnn/pa",
        ],
      },
    ],
  });
}

/**
 * Terms of service. Google lists these as optional next to the privacy policy, and its reviewers read
 * them, so they exist — short, and only promising what the code enforces. Where the privacy page is
 * about data, this is about the relationship: who runs it, what it will not do, and that it can stop.
 */
export function termsPage() {
  return renderNotice({
    title: "Terms",
    kicker: "What Reason is, what it promises, and what it does not",
    meta: `Reason at ${where()} · last changed 2026-10-06`,
    indexable: true,
    head: verificationTag(),
    links: [{ label: "Privacy policy", href: "/privacy" }, { label: "Home", href: "/" }],
    lines: [
      "Reason is a personal assistant you text. It is free software under the MIT licence, and this install of it is run by one person, who gave you the number. These terms are between you and that person.",
    ],
    sections: [
      {
        title: "What it does for you",
        lines: [
          "You ask in plain words and Reason acts: looks things up, keeps reminders and plans, reads and writes mail or calendar events on accounts you have connected yourself, finds and reads a file in a Drive you have connected, and makes phone calls or bookings when you ask it to.",
          "Anything that spends money or reaches another person stops and asks you first, and a yes covers that one thing. Reason never pays by phone, and never pretends to be you.",
        ],
      },
      {
        title: "What you agree to",
        lines: [
          "Use it for yourself, lawfully, and not to harass, deceive or harm anybody. Do not try to reach another person's data through it; nothing in it can, and trying is grounds to be removed.",
          "You are responsible for what you ask it to send, book or say on your behalf. It shows you what it is about to do before it does it; read that.",
          "You must be 13 or older.",
        ],
      },
      {
        title: "What it does not promise",
        lines: [
          "It can be wrong, late or unavailable. It is provided as is, without warranty of any kind, and the person running it is not liable for what you do with it or for a missed reminder, a wrong answer, or a booking that did not happen.",
          "Other services it reaches — Google, a phone carrier, a restaurant's website — have their own terms, and those apply to what happens there.",
        ],
      },
      {
        title: "Your data, and leaving",
        lines: [
          "How your data is handled is on the privacy page, and that page is part of these terms: /privacy",
          "You can disconnect any account, export everything, or have everything deleted at any time by asking. The person running it can pause or remove your access at any time; your data is kept until you ask for it to go.",
        ],
      },
      {
        title: "Changes",
        lines: [
          "If these terms change, this page changes and the date at the top moves. Keeping on using Reason after that is accepting the change.",
        ],
      },
    ],
  });
}
