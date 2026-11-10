// The checks an onboarding drive must pass (bin/onboarding-drive.sh), read off its outputs.
//   node onboarding-checks.cjs <outdir>     → one ok/FAIL line per check, then "all ok"
const fs = require("fs");
const out = process.argv[2];
const t = fs.readFileSync(`${out}/transcript.txt`, "utf8");
const card = fs.readFileSync(`${out}/card.vcf`, "utf8");
const [kofi = "", bubba = ""] = t.split("=== ").filter(Boolean);
const accts = JSON.parse(fs.readFileSync(`${out}/account.json`, "utf8"));
const k = accts[0] ?? {}, a = accts[1] ?? {};
const reasonLines = (s) => s.split("\n").filter(l => l.startsWith("Reason"));
const beforeBubba = bubba.split("Them              bubba")[0];
const ASK = "what do you want to call me?";
const TRY = /make a call for you.*set up and run an event/;
const PHONE_CONTROL = /save (myself|me) (in|to|into) your|in your (contacts|phone)|i'?ll save|already saved|i'?m in your/i;
// Names and the card name are kept as they typed them (src/onboarding.js), and the drive types
// lowercase, so those checks ignore case. The maker line is in Reason's lowercase voice.
const checks = [
  ["one opener, in the owner's words: the intro bubble, then the name question as its own bubble", (kofi.match(/Reason +\S+ +hey, i'm Reason\. i will help you with errands and complete your to do list for you\nReason +\S+ +what's your name\?\n/g) ?? []).length === 1 && !/to do list for you\. what's your name/.test(t)],
  ["the maker question answered with the company, never a person", /Saafi Interactions Lab/i.test(kofi) && !/Omarion|Nyarko/.test(t)],
  ["steered back to the name", /i didn't get your name/i.test(kofi)],
  ["Kofi met by the model's own line, then exactly the nickname ask", /Them +kofi\nReason +\S+ +(?!what do you want)[^\n]*Kofi[^\n]*\nReason +\S+ +what do you want to call me\?\n/i.test(kofi)],
  ["Bubba (a nickname) met by a warm line with no meaning or origin, then exactly the nickname ask", /Them +bubba\nReason +\S+ +(?!what do you want)[^\n]*bubba[^\n]*\nReason +\S+ +what do you want to call me\?\n/i.test(bubba) && !/means|meaning|origin|comes from|short for/i.test((bubba.match(/Them +bubba\nReason +\S+ +([^\n]*)/i) ?? [])[1] ?? "x means")],
  ["the card under Jarvis, on its line's message, inviting them to save it", /Jarvis it is\. here's my card, save it so you can always find me \[contact card https:\/\/cage\.example\.test\/reason-[0-9a-f]{8}-[A-Za-z0-9_-]{16}\.vcf\]/.test(kofi)],
  ["one thing to try after each card: a call and an event", TRY.test(kofi.split(/jarvis it is/i)[1] ?? "") && TRY.test(bubba.split("Reason it is")[1] ?? "")],
  ["the served card is saved as Jarvis, company Reason", /^FN:Jarvis\r?$/m.test(card) && /^ORG:Reason\r?$/m.test(card)],
  ["no interview: never asks what they do or for a to-do list", !/what do you do|to-do list/i.test(t)],
  ["no phone-control wording anywhere Reason spoke", !reasonLines(t).some(l => PHONE_CONTROL.test(l))],
  ["Kofi: name saved capitalised, card sent under Jarvis, flow complete", k.name === "Kofi" && k.card_sent === 1 && k.contact_card_name === "Jarvis" && k.onboarding === "complete"],
  ["request first: the reply, then by the way + who Reason is, then the name question in its own bubble", reasonLines(beforeBubba).length >= 3 && !reasonLines(beforeBubba)[0].includes("what's your name?") && /by the way, i'm Reason\. i will help you with errands and complete your to do list for you$/.test(reasonLines(beforeBubba).at(-2)) && /Reason +\S+ +what's your name\?$/.test(reasonLines(beforeBubba).at(-1))],
  ["skipping the card's name: the card as Reason", /Reason it is\. here's my card.*\[contact card /.test(bubba) && bubba.includes(ASK)],
  ["Bubba: nickname saved, capitalised, card as Reason, flow complete", a.name === "Bubba" && a.card_sent === 1 && a.contact_card_name === "Reason" && a.onboarding === "complete"],
];
let bad = 0;
for (const [name, ok] of checks) { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) bad++; }
console.log(bad ? `${bad} failed` : "all ok");
process.exit(bad ? 1 : 0);
