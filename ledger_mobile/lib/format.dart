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

String _groupThousands(String digits) {
  final out = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) out.write(',');
    out.write(digits[i]);
  }
  return out.toString();
}

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

String formatDay(DateTime date) {
  final local = date.toLocal();
  return '${local.day} ${_months[local.month - 1]} ${local.year}';
}
