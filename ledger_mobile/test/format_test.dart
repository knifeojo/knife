import 'package:flutter_test/flutter_test.dart';
import 'package:ledger_mobile/format.dart';

void main() {
  test('formats minor units without floating point', () {
    expect(formatMinor('198361100'), '₦1,983,611.00');
    expect(formatMinor('0'), '₦0.00');
    expect(formatMinor('-25000000'), '-₦250,000.00');
    expect(formatMinor(null), '—');
    // This value is not exact as a double. The kobo must survive.
    expect(formatMinor('9007199254740993'), '₦90,071,992,547,409.93');
  });

  test('formats US dollars when asked', () {
    expect(formatMinor('150', currency: 'USD'), r'$1.50');
  });
}
