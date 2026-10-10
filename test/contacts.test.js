// Inbound contact cards: parsing a vCard somebody shared over iMessage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVCard, describeContact, readContact, readContactsInto, readContactLine, couldNotReadContactLine, isContact } from "../src/contacts.js";
import { attachmentOf, cannotReadContactLine } from "../src/channels/sendblue.js";

test("a .vcf attachment is classified as a contact, not a file", () => {
  const a = attachmentOf("https://cdn.example.com/media/john.vcf");
  assert.equal(a.kind, "contact");
  assert.equal(a.filename, "john.vcf");
});

test("a .vcard attachment is classified as a contact", () => {
  const a = attachmentOf("https://cdn.example.com/media/john.vcard");
  assert.equal(a.kind, "contact");
});

test("isContact recognises kind: contact", () => {
  assert.ok(isContact({ kind: "contact" }));
  assert.ok(!isContact({ kind: "file" }));
  assert.ok(!isContact({ kind: "image" }));
  assert.ok(!isContact(null));
});

test("parseVCard reads name, phone, email from a simple card", () => {
  const card = parseVCard([
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Jane Doe",
    "N:Doe;Jane;;;",
    "TEL;TYPE=CELL:+14155551234",
    "EMAIL:jane@example.com",
    "END:VCARD",
  ].join("\r\n"));
  assert.equal(card.displayName, "Jane Doe");
  assert.equal(card.phones.length, 1);
  assert.equal(card.phones[0].number, "+14155551234");
  assert.equal(card.phones[0].type, "cell");
  assert.equal(card.emails[0], "jane@example.com");
});

test("parseVCard handles folded lines", () => {
  const card = parseVCard([
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:A Very Long Name That Would Be Folded In A Real Card Because It Exceeds",
    " Seventy Five Bytes",
    "TEL:+10000000000",
    "END:VCARD",
  ].join("\r\n"));
  assert.ok(card.displayName.includes("Seventy Five Bytes"));
});

test("parseVCard reads org, title, birthday, url, address, note", () => {
  const card = parseVCard([
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Kwame Asante",
    "ORG:Accra Labs",
    "TITLE:CTO",
    "BDAY:1990-03-15",
    "URL:https://kwame.dev",
    "ADR;TYPE=HOME:;;123 Main St;Accra;;00233;Ghana",
    "NOTE:Met at the conference",
    "END:VCARD",
  ].join("\r\n"));
  assert.equal(card.org, "Accra Labs");
  assert.equal(card.title, "CTO");
  assert.equal(card.bday, "1990-03-15");
  assert.equal(card.urls[0], "https://kwame.dev");
  assert.ok(card.addresses[0].includes("123 Main St"));
  assert.ok(card.addresses[0].includes("Ghana"));
  assert.equal(card.note, "Met at the conference");
});

test("parseVCard with multiple phones", () => {
  const card = parseVCard([
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Two Phones",
    "TEL;TYPE=CELL:+11111111111",
    "TEL;TYPE=WORK:+12222222222",
    "END:VCARD",
  ].join("\r\n"));
  assert.equal(card.phones.length, 2);
  assert.equal(card.phones[0].type, "cell");
  assert.equal(card.phones[1].type, "work");
});

test("parseVCard with escaped characters", () => {
  const card = parseVCard([
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Test\\, Person",
    "NOTE:Line one\\nLine two",
    "END:VCARD",
  ].join("\r\n"));
  assert.equal(card.displayName, "Test, Person");
  assert.ok(card.note.includes("Line one\nLine two"));
});

test("parseVCard returns null for non-vCard text", () => {
  assert.equal(parseVCard("just some random text"), null);
  assert.equal(parseVCard(""), null);
});

test("describeContact produces readable output", () => {
  const card = {
    displayName: "Jane Doe",
    phones: [{ number: "+14155551234", type: "cell" }],
    emails: ["jane@example.com"],
    org: "Acme",
    title: "",
    bday: "",
    urls: [],
    note: "",
    addresses: [],
  };
  const desc = describeContact(card);
  assert.ok(desc.includes("name: Jane Doe"));
  assert.ok(desc.includes("phone (cell): +14155551234"));
  assert.ok(desc.includes("email: jane@example.com"));
  assert.ok(desc.includes("org: Acme"));
});

test("readContact downloads and parses a vCard", async () => {
  const vcf = [
    "BEGIN:VCARD", "VERSION:3.0", "FN:Test Person",
    "TEL:+15005550000", "END:VCARD",
  ].join("\r\n");
  const fakeFetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from(vcf) });
  const r = await readContact({ url: "https://cdn.example.com/test.vcf", fetchImpl: fakeFetch });
  assert.ok(r.ok);
  assert.equal(r.card.displayName, "Test Person");
  assert.ok(r.description.includes("Test Person"));
});

test("readContact refuses a non-https URL", async () => {
  const r = await readContact({ url: "http://insecure.com/card.vcf" });
  assert.ok(!r.ok);
  assert.ok(r.error.includes("https"));
});

test("readContact handles a download failure", async () => {
  const fakeFetch = async () => ({ ok: false, status: 404 });
  const r = await readContact({ url: "https://cdn.example.com/gone.vcf", fetchImpl: fakeFetch });
  assert.ok(!r.ok);
  assert.ok(r.error.includes("404"));
});

test("readContact handles non-vCard content", async () => {
  const fakeFetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from("not a vcard") });
  const r = await readContact({ url: "https://cdn.example.com/fake.vcf", fetchImpl: fakeFetch });
  assert.ok(!r.ok);
  assert.ok(r.error.includes("readable contact card"));
});

test("readContactsInto replaces the placeholder with the card content", async () => {
  const a = { kind: "contact", filename: "jane.vcf", url: "https://cdn.example.com/jane.vcf" };
  const placeholder = cannotReadContactLine(a);
  const vcf = [
    "BEGIN:VCARD", "VERSION:3.0", "FN:Jane Doe",
    "TEL:+14155551234", "END:VCARD",
  ].join("\r\n");
  const fakeRead = async () => ({
    ok: true,
    card: { displayName: "Jane Doe", phones: [{ number: "+14155551234", type: "" }], emails: [], org: "", title: "", bday: "", urls: [], note: "", addresses: [] },
    description: "name: Jane Doe\nphone: +14155551234",
  });
  const out = await readContactsInto(placeholder, [a], { read: fakeRead });
  assert.ok(out.includes("Jane Doe"));
  assert.ok(!out.includes("cannot read"));
});

test("readContactsInto leaves non-contact attachments alone", async () => {
  const text = "[they sent a file, which you cannot open: doc.pdf]";
  const out = await readContactsInto(text, [{ kind: "file", filename: "doc.pdf" }]);
  assert.equal(out, text);
});
