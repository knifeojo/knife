/// Formats a minor-unit string without converting through floating point.
String formatMinor(String? minor, {String currency = 'NGN'}) {
  if (minor == null || minor.isEmpty) return '—';
  final negative = minor.startsWith('-');
  final digits = negative ? minor.substring(1) : minor;
  if (!RegExp(r'^\d+$').hasMatch(digits)) return minor;
  final value = BigInt.parse(digits);
  final whole = (value ~/ BigInt.from(100)).toString();
  final fraction = (value % BigInt.from(100)).toString().padLeft(2, '0');
  final symbol = switch (currency) {
    'NGN' => '₦',
    'USD' => r'$',
    'GBP' => '£',
    'EUR' => '€',
    'CAD' => r'CA$',
    _ => '$currency ',
  };
  return '${negative ? '-' : ''}$symbol${_groupThousands(whole)}.$fraction';
}

/// Reads a naira amount as typed ("2.5m", "500k", "₦1,200,000.50") into minor units, without floating point.
/// Returns null for anything else, zero, or more than ₦100bn.
String? parseNairaToMinor(String raw) {
  final s = raw.trim().toLowerCase().replaceAll(RegExp(r'\s+'), '').replaceFirst(RegExp(r'^(₦|ngn|n)'), '');
  final m = RegExp(r'^([\d,]*)(?:\.(\d{1,2}))?([km])?$').firstMatch(s);
  if (m == null) return null;
  final whole = m.group(1)!.replaceAll(',', '');
  final frac = m.group(2) ?? '';
  if (whole.isEmpty && frac.isEmpty) return null;
  var minor = BigInt.parse(whole.isEmpty ? '0' : whole) * BigInt.from(100) + BigInt.parse(frac.padRight(2, '0'));
  if (m.group(3) == 'k') minor *= BigInt.from(1000);
  if (m.group(3) == 'm') minor *= BigInt.from(1000000);
  if (minor <= BigInt.zero || minor > BigInt.parse('10000000000000')) return null;
  return minor.toString();
}

String _groupThousands(String digits) {
  final out = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) out.write(',');
    out.write(digits[i]);
  }
  return out.toString();
}

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// The Lagos calendar day (UTC+1, no DST) of an instant, as YYYY-MM-DD for API date filters.
String lagosDay(DateTime instant) => instant.toUtc().add(const Duration(hours: 1)).toIso8601String().substring(0, 10);

String formatDay(DateTime date) {
  final local = date.toLocal();
  return '${local.day} ${_months[local.month - 1]} ${local.year}';
}
