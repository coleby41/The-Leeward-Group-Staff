// Vendor project paperwork — contract, W-9 and COI — and Leeward's review
// of it (2026-11-10). Shared by vendor-api (the vendor's side) and
// bid-invites (staff review on Project Bid Invites), so both sides always
// agree on where a vendor stands.
//
// Each item is one of:
//   missing    the vendor still has to do it
//   waiting    on Leeward (the contract hasn't been sent yet)
//   submitted  done by the vendor
//   returned   Leeward sent it back (same file as when it was returned) —
//              becomes "submitted" again once the vendor replaces it
//   exempt     not needed (contract not needed, W-9 / COI exempt)
//
// The project:
//   open       something is still missing / waiting / returned
//   in_review  everything is in; waiting on Leeward to review it
//   approved   Leeward approved every item — the project unlocks
//
// Staff can only decide when status is in_review, and they send every
// item's decision back to the vendor in one request.

// deno-lint-ignore no-explicit-any
type Row = any;

export type ItemKey = "contract" | "w9" | "coi";
export const ITEMS: ItemKey[] = ["contract", "w9", "coi"];
export type ItemState = "missing" | "waiting" | "submitted" | "returned" | "exempt";

export interface PaperworkState {
  status: "open" | "in_review" | "approved";
  items: Record<ItemKey, { state: ItemState; ref: string | null; note: string | null; decision: string | null }>;
  note: string | null;          // the general note from Leeward's last decision
  decided_at: string | null;
  approved_at: string | null;
}

export function paperworkState(input: {
  contract: Row | null;      // project_vendor_contracts row
  company: Row;              // Companies row (W9FilePath, W9Exempt, COIExempt)
  coiFileId: string | null;  // this vendor's project COI file
  review: Row | null;        // project_vendor_reviews row
}): PaperworkState {
  const { contract: k, company: c, coiFileId, review: r } = input;
  const item = (key: ItemKey, exempt: boolean, ref: string | null, returnedRef: string | null, waiting = false) => {
    let state: ItemState;
    if (exempt) state = "exempt";
    else if (ref && returnedRef && String(ref) === String(returnedRef)) state = "returned";
    else if (ref) state = "submitted";
    else state = waiting ? "waiting" : "missing";
    return {
      state,
      ref: ref ? String(ref) : null,
      note: state === "returned" ? (r?.[`${key}_note`] || null) : null,
      decision: r?.[`${key}_status`] || null,
    };
  };
  const items = {
    contract: item("contract", Boolean(k?.not_needed), k?.signed_file_id || null, r?.contract_returned_file_id || null, !k?.file_id),
    w9: item("w9", Boolean(c?.W9Exempt), c?.W9FilePath || null, r?.w9_returned_path || null),
    coi: item("coi", Boolean(c?.COIExempt), coiFileId || null, r?.coi_returned_file_id || null),
  };
  const allIn = ITEMS.every((key) => items[key].state === "submitted" || items[key].state === "exempt");
  const status = r?.approved_at ? "approved" : allIn ? "in_review" : "open";
  return {
    status,
    items,
    note: r?.last_decision === "returned" ? (r?.note || null) : null,
    decided_at: r?.decided_at || null,
    approved_at: r?.approved_at || null,
  };
}

export const ITEM_LABELS: Record<"en" | "es", Record<ItemKey, string>> = {
  en: { contract: "Contract", w9: "W-9", coi: "Certificate of Insurance (COI)" },
  es: { contract: "Contrato", w9: "W-9", coi: "Certificado de Seguro (COI)" },
};
