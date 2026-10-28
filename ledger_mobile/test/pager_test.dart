import 'package:flutter_test/flutter_test.dart';
import 'package:ledger_mobile/api/models.dart';
import 'package:ledger_mobile/state/transaction_pager.dart';

LedgerTransaction _tx(String id, String day, {String name = 'Example Shop'}) {
  return LedgerTransaction(
    id: id,
    accountId: 'a1',
    transactionDate: DateTime.parse('${day}T12:00:00.000Z'),
    type: 'DEBIT',
    amountMinor: '100000',
    currency: 'NGN',
    description: name,
    merchantName: name,
    category: 'Shopping',
  );
}

TransactionPage _page(List<LedgerTransaction> rows, {String? next, List<DayTotal> days = const []}) {
  return TransactionPage(transactions: rows, categories: const ['Shopping'], nextCursor: next, dayTotals: days);
}

void main() {
  test('pager appends pages with no duplicates and groups by Lagos day', () async {
    var calls = 0;
    final pager = TransactionPager(({cursor}) async {
      calls += 1;
      if (cursor == null) {
        return _page(
          [_tx('t1', '2026-10-23'), _tx('t2', '2026-10-23'), _tx('t3', '2026-10-22')],
          next: 'cursor-2',
          days: const [
            DayTotal(date: '2026-10-23', netMinor: '-500000', inMinor: '0', outMinor: '500000'),
            DayTotal(date: '2026-10-22', netMinor: '-200000', inMinor: '0', outMinor: '200000'),
          ],
        );
      }
      return _page([_tx('t3', '2026-10-22'), _tx('t4', '2026-10-21')], next: null);
    });

    await pager.refresh();
    expect(pager.items.map((t) => t.id), ['t1', 't2', 't3']);
    expect(pager.nextCursor, 'cursor-2');
    expect(pager.done, isFalse);
    expect(pager.groups.map((g) => g.date), ['2026-10-23', '2026-10-22']);
    expect(pager.groups.first.total?.outMinor, '500000');

    await pager.loadMore();
    expect(pager.items.map((t) => t.id), ['t1', 't2', 't3', 't4']);
    expect(pager.done, isTrue);
    expect(calls, 2);
    expect(pager.groups.map((g) => g.date), ['2026-10-23', '2026-10-22', '2026-10-21']);
  });

  test('refresh clears the cursor and starts again', () async {
    var calls = 0;
    final pager = TransactionPager(({cursor}) async {
      calls += 1;
      return _page([_tx('t$calls', '2026-10-23')], next: null);
    });
    await pager.loadMore();
    await pager.refresh();
    expect(pager.items.single.id, 't2');
    expect(calls, 2);
  });
}
