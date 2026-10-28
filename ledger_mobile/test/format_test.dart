import 'package:flutter_test/flutter_test.dart';
import 'package:ledger_mobile/format.dart';

void main() {
  test('formats minor units without floating point', () {
    expect(formatMinor('198361100'), '₦1,983,611.00');
    expect(formatMinor('0'), '₦0.00');
    expect(formatMinor('-25000000'), '-₦250,000.00');
    expect(formatMinor(null), '-');
    // This value is not exact as a double. The kobo must survive.
    expect(formatMinor('9007199254740993'), '₦90,071,992,547,409.93');
  });

  test('formats US dollars when asked', () {
    expect(formatMinor('150', currency: 'USD'), r'$1.50');
  });

  test('formats Ghana, Kenya and West African francs', () {
    expect(formatMinor('250050', currency: 'GHS'), '₵2,500.50');
    expect(formatMinor('10000', currency: 'KES'), 'KSh100.00');
    expect(formatMinor('500000', currency: 'XOF'), 'CFA5,000.00');
    expect(formatMinor('812', currency: 'CAD'), r'CA$8.12');
    expect(formatMinor('435', currency: 'GBP'), '£4.35');
  });

  test('formats compact home amounts without floating point', () {
    expect(formatCompactMinor('125000000'), '₦1.25M');
    expect(formatCompactMinor('198361100'), '₦1.98M');
    expect(formatCompactMinor('98000000'), '₦980k');
    expect(formatCompactMinor('27000000'), '₦270k');
    expect(formatCompactMinor('-50000000'), '-₦500k');
    expect(formatCompactMinor(null), '-');
    expect(percentFromBp(2160), 22);
    expect(percentFromBp(4286), 43);
    expect(formatLagosDayHeader('2026-10-23'), 'Fri 23 Oct');
    expect(shiftYearMonth('2026-10', -1), '2026-09');
    expect(formatYearMonth('2026-10'), 'October 2026');
  });

  test('reads typed naira amounts as minor units without floating point', () {
    expect(parseNairaToMinor('2.5m'), '250000000');
    expect(parseNairaToMinor('500k'), '50000000');
    expect(parseNairaToMinor('₦1,200,000.50'), '120000050');
    expect(parseNairaToMinor(' 750000 '), '75000000');
    expect(parseNairaToMinor('0.1'), '10');
    for (final bad in ['', '0', '-5', 'abc', '1e9', '1.234', '999999999999m']) {
      expect(parseNairaToMinor(bad), isNull, reason: bad);
    }
  });
}
