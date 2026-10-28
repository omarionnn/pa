// The Strand, 2026-10-27, 20:32 ET — live call 45 (conv_4801m5zyqj5jeen80p7wbw0x2xmk), as ElevenLabs
// transcribed their side and as a local whisper pass on the recording timed it. These are the words
// Reason's endpoint was actually handed, so the tests replay the real call rather than an invented one.
//
//   0.0s   Reason's disclosure goes out at pick-up (the agent's first message) …
//   4.1s   … and is cut off at "calling for Omari. Just..." by the store's recording starting
//   4–92s  the recording: hours for four locations, the used-book desk, "we're not accepting customer
//          phone inquiries, but we will happily reply to emails sent to web@strandbooks.com", "if you
//          know your party's extension, please dial it now", "once again, thank you for calling"
//   94s    Reason, OUT LOUD: "This is a recorded message, and it says they aren't taking customer phone
//          inquiries." — then skip_turn. No key was pressed (menu_presses []).
//   99.5s  the menu times out to its default mailbox: "Extension 199 is unavailable. This voice mailbox
//          is not accepting new messages at this time."
//   108s   the Strand's system hangs up ("Call ended by remote party").
export const STRAND_RECORDING = "Our flagship store at 828 Broadway is open every day from 10:00 a.m. until 9:00 p.m."
  + " The hours for our Upper West Side location at 450 Columbus Avenue are Monday through Saturday, 10:00 a.m. until 8:00 p.m.,"
  + " and Sunday, 10:00 till 7:00. Our Lincoln Center location is open Monday through Saturday, 9:00 a.m. until 8:00 p.m.,"
  + " and Sundays from 10:00 till 7:00. Our Central Park kiosk is open every day from 10:00 a.m. until 5:00 p.m., weather permitting."
  + " The used book buying desk is open Thursday through Saturday from 10:00 a.m. until 4:00 p.m. We can assess smaller"
  + " collections during that time at our downtown Broadway location. Our seller's entrance is on 12th Street between"
  + " Broadway and 4th Avenue. Larger collections are taken in by appointment. For more information, please visit our"
  + " website at strandbooks.com. Please be aware that at this time we're not accepting customer phone inquiries, but we"
  + " will happily reply to emails that are sent to web at strandbooks.com. If you know your party's extension, please dial"
  + " it now. Once again, thank you for calling the Strand.";

export const STRAND_MAILBOX = "Extension 199 is unavailable. This voice mailbox is not accepting new messages at this time.";

/** What Reason said into the recording on the real call, which must never be spoken again. */
export const SAID_INTO_IT = "This is a recorded message, and it says they aren't taking customer phone inquiries.";

export const STRAND = "+12124731452";
export const STRAND_GOAL = "Ask whether the Strand at 828 Broadway has \"Thank God for Cats\" by Linda Clare in stock, and if so"
  + " how many copies, the price, and whether they can hold one. Only asking, not buying.";
