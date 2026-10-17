import { Tag } from "../ui/Tag";
import { PLAN_BASIS_LABEL, PLAN_BASIS_TAG, PLAN_BASIS_TONE, planBasisDetail, type PlanBasis } from "./planBasis";

/** Short tag for a panel header; the full wording is in the title and in PlanBasisNote. */
export function PlanBasisTag({ basis }: { basis: PlanBasis }) {
  return (
    <Tag tone={PLAN_BASIS_TONE[basis.kind]} title={PLAN_BASIS_LABEL[basis.kind]}>
      {PLAN_BASIS_TAG[basis.kind]}
    </Tag>
  );
}

/** The agreed full wording plus what it means here. */
export function PlanBasisNote({ basis }: { basis: PlanBasis }) {
  return (
    <p className="plan-basis" role="note">
      <strong>{PLAN_BASIS_LABEL[basis.kind]}.</strong> {planBasisDetail(basis)}
    </p>
  );
}
