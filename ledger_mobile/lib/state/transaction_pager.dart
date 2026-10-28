import '../api/models.dart';
import '../format.dart';

typedef TransactionPageFetch = Future<TransactionPage> Function({String? cursor});

class DayGroup {
  const DayGroup({required this.date, required this.rows, this.total});

  final String date;
  final List<LedgerTransaction> rows;
  final DayTotal? total;
}

/// Cursor-backed transaction list: 30 per page, no duplicates, stable across pages.
class TransactionPager {
  TransactionPager(this.fetch);

  final TransactionPageFetch fetch;

  final List<LedgerTransaction> items = [];
  final Map<String, DayTotal> dayTotals = {};
  String? nextCursor;
  bool loading = false;
  bool done = false;
  Object? error;
  List<String> categories = const [];

  List<DayGroup> get groups {
    final byDay = <String, List<LedgerTransaction>>{};
    final order = <String>[];
    for (final tx in items) {
      final day = lagosDay(tx.transactionDate);
      (byDay[day] ??= []).add(tx);
      if (order.isEmpty || order.last != day) order.add(day);
    }
    return [
      for (final day in order) DayGroup(date: day, rows: byDay[day]!, total: dayTotals[day]),
    ];
  }

  Future<void> refresh() async {
    items.clear();
    dayTotals.clear();
    nextCursor = null;
    done = false;
    error = null;
    await loadMore();
  }

  Future<void> loadMore() async {
    if (loading || done) return;
    loading = true;
    error = null;
    try {
      final page = await fetch(cursor: nextCursor);
      final seen = {for (final tx in items) tx.id};
      for (final tx in page.transactions) {
        if (seen.add(tx.id)) items.add(tx);
      }
      for (final day in page.dayTotals) {
        dayTotals[day.date] = day;
      }
      if (page.categories.isNotEmpty) categories = page.categories;
      nextCursor = page.nextCursor;
      done = page.nextCursor == null;
    } catch (e) {
      error = e;
    } finally {
      loading = false;
    }
  }

  bool get nearEnd => items.isNotEmpty && !done && !loading;
}
