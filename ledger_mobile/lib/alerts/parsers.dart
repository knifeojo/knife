import 'senders.dart';

class ParsedSms {
  const ParsedSms({
    required this.institution,
    required this.type,
    required this.amountMinor,
    required this.currency,
    required this.transactionDate,
    required this.description,
    this.balanceAfterMinor,
    this.accountLast4,
    required this.confidence,
    required this.autoPost,
    required this.parser,
  });

  final String institution;
  final String type;
  final String amountMinor;
  final String currency;
  final DateTime transactionDate;
  final String description;
  final String? balanceAfterMinor;
  final String? accountLast4;
  final double confidence;
  final bool autoPost;
  final String parser;

  Map<String, Object?> toJson() => {
    'institution': institution,
    'type': type,
    'amountMinor': amountMinor,
    'currency': currency,
    'transactionDate': transactionDate.toIso8601String(),
    'description': description,
    'balanceAfterMinor': balanceAfterMinor,
    'accountLast4': accountLast4,
    'confidence': confidence,
    'autoPost': autoPost,
    'parser': parser,
  };
}

final _money = RegExp(r'([\d,]+(?:\.\d{1,2})?)');

String? _kobo(String? raw) {
  if (raw == null) return null;
  final m = _money.firstMatch(raw.replaceAll(' ', ''));
  if (m == null) return null;
  final parts = m.group(1)!.replaceAll(',', '').split('.');
  final whole = int.tryParse(parts[0]);
  if (whole == null) return null;
  final frac = (parts.length > 1 ? parts[1] : '0').padRight(2, '0').substring(0, 2);
  return '${whole * 100 + int.parse(frac)}';
}

String? _last4(String? raw) {
  if (raw == null) return null;
  final digits = raw.replaceAll(RegExp(r'[^0-9]'), '');
  if (digits.length < 3) return null;
  return digits.substring(digits.length - (digits.length >= 4 ? 4 : digits.length));
}

String _trimDesc(String raw) => raw.replaceAll(RegExp(r'^[\s.-]+|[\s.]+$'), '').replaceAll(RegExp(r'\s+'), ' ').trim();

DateTime? _lagos(DateTime? utcFallback, int y, int mo, int d, int h, int mi, [int s = 0]) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return utcFallback;
  return DateTime.utc(y, mo, d, h - 1, mi, s);
}

const _months = {
  'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
  'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12,
};

/// Same patterns as `finance-app/src/core/alerts`. Device and server stay in sync via `/api/v1/alerts/parsers` senders.
ParsedSms? parseBankSms({required String sender, required String body, DateTime? receivedAt}) {
  if (!isAllowedSmsSender(sender) || isBankMarketing(body)) return null;
  final now = receivedAt ?? DateTime.now().toUtc();
  if (sender.toLowerCase() == 'gtbank') return _gtbank(body, now);
  if (sender.toLowerCase() == 'firstbank') return _firstbank(body, now);
  if (sender.toLowerCase() == 'sterling') return _sterling(body, now);
  if (sender.toLowerCase() == 'providus') return _providus(body, now);
  return _fallback(body, now);
}

ParsedSms? _gtbank(String body, DateTime receivedAt) {
  final amt = RegExp(r'Amt:\s*(NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)\s*(DR|CR)', caseSensitive: false).firstMatch(body);
  if (amt == null) return null;
  final kobo = _kobo(amt.group(2));
  if (kobo == null) return null;
  final acct = RegExp(r'Acct:\s*([*\dX]+)', caseSensitive: false).firstMatch(body)?.group(1);
  final bal = _kobo(RegExp(r'Bal:\s*(NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)', caseSensitive: false).firstMatch(body)?.group(2));
  final date = RegExp(r'Date:\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?', caseSensitive: false).firstMatch(body);
  var desc = '';
  final descM = RegExp(r'Desc:\s*([\s\S]+?)(?:\n\s*(?:Bal|Date):|$)', caseSensitive: false).firstMatch(body);
  if (descM != null) desc = _trimDesc(descM.group(1)!.replaceAll('\n', ' '));
  var hour = date == null ? receivedAt.hour : int.parse(date.group(4)!);
  final ap = date?.group(6)?.toUpperCase();
  if (ap == 'PM' && hour < 12) hour += 12;
  if (ap == 'AM' && hour == 12) hour = 0;
  final when = date == null
      ? receivedAt
      : _lagos(receivedAt, int.parse(date.group(1)!), int.parse(date.group(2)!), int.parse(date.group(3)!), hour, int.parse(date.group(5)!)) ?? receivedAt;
  return ParsedSms(
    institution: 'GTBank',
    type: amt.group(3)!.toUpperCase() == 'CR' ? 'CREDIT' : 'DEBIT',
    amountMinor: kobo,
    currency: 'NGN',
    transactionDate: when,
    description: desc,
    balanceAfterMinor: bal,
    accountLast4: _last4(acct),
    confidence: 0.95,
    autoPost: true,
    parser: 'GTBankSmsParser',
  );
}

ParsedSms? _firstbank(String body, DateTime receivedAt) {
  final line = body.replaceAll(RegExp(r'\s+'), ' ').trim();
  final m = RegExp(
    r'^(Debit|Credit):\s*(\S+)\s+Amt:\s*(NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)\s+Date:\s*(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+Desc:\s*(.+?)\s+Bal:\s*(NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)(CR|DR)?',
    caseSensitive: false,
  ).firstMatch(line);
  if (m == null) return null;
  final kobo = _kobo(m.group(4));
  if (kobo == null) return null;
  var desc = m.group(11)!.replaceFirst(RegExp(r'^(?:FIP|ISW):[A-Z]{2,4}(?::[A-Z0-9]+)?/', caseSensitive: false), '');
  desc = _trimDesc(desc.split('/').first);
  final mo = _months[m.group(6)!.substring(0, 3).toLowerCase()] ?? 1;
  final when = _lagos(receivedAt, int.parse(m.group(7)!), mo, int.parse(m.group(5)!), int.parse(m.group(8)!), int.parse(m.group(9)!), int.parse(m.group(10)!)) ?? receivedAt;
  final bal = _kobo(m.group(13));
  final overdrawn = (m.group(14) ?? '').toUpperCase() == 'DR';
  return ParsedSms(
    institution: 'First Bank',
    type: m.group(1)!.toLowerCase() == 'credit' ? 'CREDIT' : 'DEBIT',
    amountMinor: kobo,
    currency: 'NGN',
    transactionDate: when,
    description: desc,
    balanceAfterMinor: bal == null ? null : overdrawn ? '-$bal' : bal,
    accountLast4: _last4(m.group(2)),
    confidence: 0.95,
    autoPost: true,
    parser: 'FirstBankSmsParser',
  );
}

ParsedSms? _sterling(String body, DateTime receivedAt) {
  final line = body.replaceAll(RegExp(r'\s+'), ' ');
  final out = RegExp(
    r'Money Out!\s*You have spent,\s*(NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)\s+at\s+(.+?)\s+from\s+([*\dX]+)\s+at\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.\s*You have\s*(NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)',
    caseSensitive: false,
  ).firstMatch(line);
  final inn = out != null
      ? null
      : RegExp(
          r'Money In!\s*(NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)\s+has arrived from\s+(.+?)\s+into\s+([*\dX]+)\s+at\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.\s*You have\s*(NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)',
          caseSensitive: false,
        ).firstMatch(line);
  final m = out ?? inn;
  if (m == null) return null;
  final kobo = _kobo(m.group(2));
  if (kobo == null) return null;
  final when = _lagos(receivedAt, int.parse(m.group(5)!), int.parse(m.group(6)!), int.parse(m.group(7)!), int.parse(m.group(8)!), int.parse(m.group(9)!), int.parse(m.group(10)!)) ?? receivedAt;
  return ParsedSms(
    institution: 'Sterling Bank',
    type: out != null ? 'DEBIT' : 'CREDIT',
    amountMinor: kobo,
    currency: 'NGN',
    transactionDate: when,
    description: _trimDesc(m.group(3)!),
    balanceAfterMinor: _kobo(m.group(12)),
    accountLast4: _last4(m.group(4)),
    confidence: 0.92,
    autoPost: true,
    parser: 'SterlingSmsParser',
  );
}

ParsedSms? _providus(String body, DateTime receivedAt) {
  final m = RegExp(
    r'^(Debit|Credit)\s+Alert:\s*(NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)\s+(?:MOB:\s*)?(?:To|From)?\s*(.+)$',
    caseSensitive: false,
  ).firstMatch(body.replaceAll(RegExp(r'\s+'), ' ').trim());
  if (m == null) return null;
  final kobo = _kobo(m.group(3));
  if (kobo == null) return null;
  final party = (m.group(4) ?? '').replaceFirst(RegExp(r'\|.*$'), '').trim();
  return ParsedSms(
    institution: 'Providus Bank',
    type: m.group(1)!.toLowerCase() == 'credit' ? 'CREDIT' : 'DEBIT',
    amountMinor: kobo,
    currency: 'NGN',
    transactionDate: receivedAt,
    description: party.isEmpty ? body : party,
    confidence: 0.4,
    autoPost: false,
    parser: 'ProvidusSmsParser',
  );
}

ParsedSms? _fallback(String body, DateTime receivedAt) {
  final amt = RegExp(r'(?:amt|amount|NGN|₦)\s*[:\s]*([\d,]+(?:\.\d{1,2})?)', caseSensitive: false).firstMatch(body);
  final debit = RegExp(r'\b(debit|dr|money out)\b', caseSensitive: false).hasMatch(body);
  final credit = RegExp(r'\b(credit|cr|money in)\b', caseSensitive: false).hasMatch(body);
  if (amt == null || debit == credit) return null;
  final kobo = _kobo(amt.group(1));
  if (kobo == null) return null;
  return ParsedSms(
    institution: 'Unknown',
    type: debit ? 'DEBIT' : 'CREDIT',
    amountMinor: kobo,
    currency: 'NGN',
    transactionDate: receivedAt,
    description: body,
    confidence: 0.35,
    autoPost: false,
    parser: 'GenericFallback',
  );
}
