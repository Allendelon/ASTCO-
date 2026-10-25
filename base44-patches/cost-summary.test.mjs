import test from 'node:test';
import assert from 'node:assert/strict';
const { costSummaryByDiscipline } = await import(process.env.LIB);

test('per-discipline budget, committed, savings, competition, pipeline', () => {
  const rfqs = [
    { id: 'a', discipline: 'Piping', budget: 100, status: 'Awarded' },
    { id: 'b', discipline: 'Piping', budget: 50, status: 'Issued' },
    { id: 'c', discipline: 'Electrical', budget: 200, status: 'Awarded' },
    { id: 'd', discipline: 'Electrical', budget: 999, status: 'Cancelled' },
    { id: 'e', discipline: 'HVAC', budget: 70, status: 'Awarded', currency: 'USD' },
  ];
  const pos = [
    { rfq_id: 'a', amount: 90, status: 'Issued' },
    { rfq_id: 'c', amount: 220, status: 'Delivered' },
    { rfq_id: 'c', amount: 5, status: 'Cancelled' },
    { rfq_id: 'e', amount: 60, status: 'Issued', currency: 'USD' },
  ];
  const quotes = [
    { rfq_id: 'a', total_price: 90 }, { rfq_id: 'a', total_price: 110 }, { rfq_id: 'a', total_price: 1, status: 'Withdrawn' },
    { rfq_id: 'c', total_price: 220 },
  ];
  const s = costSummaryByDiscipline({ rfqs, pos, quotes });
  const piping = s.rows.find((r) => r.discipline === 'Piping');
  const elec = s.rows.find((r) => r.discipline === 'Electrical');
  assert.deepEqual(
    [piping.rfqCount, piping.budget, piping.committed, piping.savings, piping.competition, piping.pipeline, piping.savingsPct],
    [2, 150, 90, 10, 10, 50, 10]
  );
  assert.deepEqual([elec.rfqCount, elec.budget, elec.committed, elec.savings, elec.competition, elec.competedPos, piping.competedPos], [1, 200, 220, -20, 0, 0, 1]);
  assert.equal(s.totals.savings, -10);
  assert.equal(s.totals.committed, 310);
  assert.deepEqual(s.excluded, { rfqs: 1, pos: 1 });
  assert.equal(s.rows.some((r) => r.discipline === 'HVAC'), false);
});

test('PO without an RFQ is reported as Unassigned and has no savings', () => {
  const s = costSummaryByDiscipline({ rfqs: [], pos: [{ amount: 40, status: 'Issued' }], quotes: [] });
  assert.equal(s.rows[0].discipline, 'Unassigned');
  assert.equal(s.rows[0].committed, 40);
  assert.equal(s.rows[0].savingsPct, null);
});
