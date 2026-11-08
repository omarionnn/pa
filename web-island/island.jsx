// The only React on any Reason page: Crossmint's own two fields, mounted into a server-drawn page.
//
//   ReasonCrossmint.protectedField(el, { apiKey, jwt, field, appearance }) → { collect(), setInvalid(b), setDisabled(b) }
//       One CrossmintProtectedInput (a password or a one-time code). The value is typed into Crossmint's
//       iframe and goes to Crossmint; this page only ever gets back { protectedInputId }.
//   ReasonCrossmint.cardForm(el, { apiKey, jwt, appearance, onSaved, onError })
//       Crossmint's card form (CrossmintPaymentMethodManagement, "new" only). The card goes to Crossmint;
//       this page gets back the paymentMethodId and the display fields (brand, last four).
//   ReasonCrossmint.cvcField(el, { apiKey, jwt, paymentMethodId, appearance }) → { submit() }
//       Crossmint's hosted CVC field (CrossmintCvcRecollection), for a saved card whose security code
//       Crossmint no longer keeps (the order intent's encrypted-card rail says pending_cvc_recollection).
//       The digits are typed into Crossmint's iframe and stored by Crossmint; this page gets back only
//       a status (complete / invalid / failed / refused / unavailable / superseded), never the code.
//
// Built by web-island/build.sh into assets/connect/crossmint-island.js (committed, served by
// src/pages/webconnect.js). Rebuild after changing this file or bumping the pinned SDK.
import { createRoot } from "react-dom/client";
import { createRef, useImperativeHandle, useRef, useState, forwardRef } from "react";
import { CrossmintProvider, CrossmintProtectedInput, CrossmintPaymentMethodManagement, CrossmintCvcRecollection } from "@crossmint/client-sdk-react-ui";

const Protected = forwardRef(function Protected({ apiKey, jwt, field, appearance }, ref) {
  const inner = useRef(null);
  const [invalid, setInvalid] = useState(false);
  const [disabled, setDisabled] = useState(false);
  useImperativeHandle(ref, () => ({
    collect: () => inner.current ? inner.current.collect() : Promise.resolve({ status: "unavailable", message: "Not ready yet." }),
    setInvalid, setDisabled,
  }));
  return (
    <CrossmintProvider apiKey={apiKey}>
      <CrossmintProtectedInput ref={inner} jwt={jwt} field={field} appearance={appearance} invalid={invalid} disabled={disabled} />
    </CrossmintProvider>
  );
});

function protectedField(el, opts) {
  const ref = createRef();
  createRoot(el).render(<Protected ref={ref} {...opts} />);
  return {
    collect: () => ref.current ? ref.current.collect() : Promise.resolve({ status: "unavailable", message: "Not ready yet." }),
    setInvalid: (b) => ref.current && ref.current.setInvalid(!!b),
    setDisabled: (b) => ref.current && ref.current.setDisabled(!!b),
  };
}

// Only the display fields leave this function: never card.source (a vault token id).
const summary = (pm) => pm && pm.type === "card"
  ? { paymentMethodId: pm.paymentMethodId, brand: pm.card?.brand ?? "", last4: pm.card?.last4 ?? "" }
  : null;

function cardForm(el, { apiKey, jwt, appearance }) {
  const ref = createRef();
  createRoot(el).render(
    <CrossmintProvider apiKey={apiKey}>
      <CrossmintPaymentMethodManagement ref={ref} jwt={jwt} appearance={appearance} allowedModes={["new"]} hideSubmitButton />
    </CrossmintProvider>,
  );
  return {
    // Resolves { status: "saved", card: { paymentMethodId, brand, last4 } } or { status, message }.
    async submit() {
      if (!ref.current) return { status: "unavailable", message: "The card form is still loading." };
      const r = await ref.current.submit();
      if (r.status === "saved" || r.status === "selected") return { status: "saved", card: summary(r.paymentMethod) };
      return { status: r.status, message: r.message || "" };
    },
  };
}

// Only a status leaves this function (the SDK's submit() never rejects and never returns the code).
function cvcField(el, { apiKey, jwt, paymentMethodId, appearance }) {
  const ref = createRef();
  createRoot(el).render(
    <CrossmintProvider apiKey={apiKey}>
      <CrossmintCvcRecollection ref={ref} jwt={jwt} paymentMethodId={paymentMethodId} appearance={appearance} hideSubmitButton />
    </CrossmintProvider>,
  );
  return {
    async submit() {
      if (!ref.current) return { status: "unavailable", message: "The field is still loading." };
      const r = await ref.current.submit();
      return { status: r.status, ...(r.reason ? { reason: r.reason } : {}) };
    },
  };
}

window.ReasonCrossmint = { protectedField, cardForm, cvcField };
