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
//      60 messages of a thread, tool results included (`saveConversation` / `trimHistory` in
//      src/agent.js). So an email Reason read is on the disk until it falls out of that window.
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

export function homePage() {
  return renderNotice({
    title: "Reason",
    kicker: "A personal assistant that lives in your texts",
    lines: [
      "Reason is an assistant you text like a friend. You ask it for things in plain words — look this up, remind me, sort this out, what's on Thursday — and it does them, keeps track of what is still open, and comes back when there is something real to say.",
      "It is one person's assistant at a time. Everyone who texts it gets their own: their own memory, their own connected accounts, their own history. Nobody can see anybody else's.",
      "It only connects to something when you connect it yourself. If you want it to work with your email or your calendar, you ask, it sends you a link, and you agree on Google's own page. It never asks for a password, for anything.",
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
  });
}

export function privacyPage() {
  return renderNotice({
    title: "Privacy",
    kicker: "What Reason keeps, and what it does not",
    meta: `Reason at ${where()} · last changed 2026-10-05`,
    indexable: true,
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
          "If you connect Google, Reason asks for exactly two permissions and no others: Gmail (read, search, draft, send, label, archive, and move to the bin) and Calendar (read and write events). It deliberately cannot delete your mail permanently, because the permission that would allow that is not one it asks for.",
          "Reason uses your Gmail and Calendar data only to do the thing you asked for in the conversation you asked in. Nothing else reads it. It is never sold, never shared with a data broker, never used for advertising of any kind, and never used to train or improve any model.",
          "It does not copy your mailbox. It asks Google for what it needs when you ask a question, and what comes back lives in your transcript as described above until it falls off it. Attachments are never downloaded or opened — Reason lists what is attached and says that is all it can do.",
          "No access token or refresh token ever leaves the machine. They are not in an export, not in a receipt, and not written to a log.",
          "Anything inside an email or a calendar invite is treated as information and never as an instruction. An email that tells Reason to forward itself, or to reply with a code, gets reported to you, naming who asked. It cannot make Reason act: the permission gate reads your own replies in your own conversation, and an email is not one of those.",
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
          "When you ask Reason to do something with a service, it talks to that service: Google for your mail and calendar, and whichever of a search provider, a telephony provider or a payments provider is set up on this install. It sends what the request needs and nothing more.",
          "That is the whole list. Nothing is sent anywhere for analytics, advertising, or model training.",
        ],
      },
      {
        title: "Disconnecting",
        lines: [
          "Text Reason and ask it to disconnect your Google, or to stop reading your email. It revokes the connection at Google and deletes the stored tokens from the machine. If Google will not confirm the revoke, Reason tells you so rather than claiming it is done.",
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
