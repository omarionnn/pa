// Which call provider this install runs, from one environment variable.
//
// One place rather than a `new FakeCallProvider()` in each entry point, because the thing that must
// never drift is what `capabilities` says: it reads the provider's own `status()`, so if the
// process picks a different provider from the one the owner configured, Reason tells people the
// wrong thing about whether it can ring a phone.
//
// An unknown name is not quietly treated as `fake`. It comes back as a provider that is not
// connected and says which name it did not recognise — a typo in REASON_CALL_PROVIDER should look
// like a typo, not like a working install that mysteriously never calls anyone.
import { CallProvider } from "./provider.js";
import { FakeCallProvider } from "./fake.js";
import { BlandCallProvider } from "./bland.js";
import { config } from "../config.js";

export const CALL_PROVIDERS = ["bland", "fake"];

export function chooseCallProvider({ provider = null, fetchImpl = null } = {}) {
  const name = String(provider ?? config.callProvider ?? "fake").trim().toLowerCase();

  if (name === "bland") return new BlandCallProvider({ fetchImpl });

  // The fake dials nothing and is registered switched OFF, so an install that has not chosen a
  // provider reports phone calls as not connected rather than as a thing that works. Tests switch
  // it on themselves.
  if (name === "fake" || name === "") return new FakeCallProvider({ live: false });

  const unknown = new CallProvider();
  unknown.name = name;
  unknown.status = () => ({
    name,
    status: "not_connected",
    missing: ["REASON_CALL_PROVIDER"],
    what: `'${name}' is not a call provider Reason has. It has: ${CALL_PROVIDERS.join(", ")}.`,
    records: false,
  });
  return unknown;
}
