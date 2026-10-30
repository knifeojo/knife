import 'senders.dart';

/// On-device financial SMS classifier.
///
/// Mirror of `android/.../sms/FinancialSms.kt`. Keep the weights, threshold,
/// exclusions, and reason strings identical.
///
/// Score (financial when score >= [financialScoreThreshold] and nothing excludes the text):
/// - currency amount (NGN, ₦, N, USD, GBP, EUR, $, £, €): +3
/// - debit/credit/DR/CR/spent/money in/out/has arrived: +2
/// - txn/transfer/POS: +1
/// - balance/Bal/Avl: +2
/// - masked account: +2
/// - alphanumeric bank-style sender id: +1
///
/// Exclusions win: OTP, promo (unless a real amount sits with a direction or a balance),
/// personal phone chats, telco/promo sender ids.
/// Known banks ([defaultBankSenders]) skip the prompt. A new financial sender is [SenderAction.ask].
const financialScoreThreshold = 5;

enum SenderAction { upload, ask, drop }

class SmsClassification {
  const SmsClassification({
    required this.financial,
    required this.score,
    required this.reason,
  });

  final bool financial;
  final int score;
  final String reason;
}

final _phone = RegExp(r'^\+?\d{8,15}$');
final _currency = RegExp(
  r'(?:NGN|USD|GBP|EUR|₦|[$£€])\s*[\d,]+(?:\.\d{1,2})?|\bN\s?[\d]{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\bN\s?\d+\.\d{2}\b',
  caseSensitive: false,
);
final _direction = RegExp(
  r'\b(debit(?:ed)?|credit(?:ed)?|dr|cr|money\s+out|money\s+in|spent|has arrived|withdrawn)\b',
  caseSensitive: false,
);
final _txn = RegExp(
  r'\b(txn|transaction|transfer(?:red)?|nip|pos)\b',
  caseSensitive: false,
);
final _balance = RegExp(
  r'\b(balance|bal|avl|avail(?:able)?)\b',
  caseSensitive: false,
);
final _masked = RegExp(
  r'(?:\*{2,}|x{2,})\d{2,6}|\d{3,}x{2,}\d{2,4}|(?:acct|account|a/c)\s*[:\s]*[*x\d]{4,}',
  caseSensitive: false,
);
final _letter = RegExp(r'[A-Za-z]');
final _otp = RegExp(
  r'\b(otp|one[-\s]?time (?:password|pin|code)|verification code|do not share(?: this)? (?:code|otp)|your code is)\b|\b(?:code|otp)\s*(?:is|:)\s*\d{4,8}\b',
  caseSensitive: false,
);
final _promo = RegExp(
  r'congratulations! you have a loan offer|alwayson overdraft|keep transacting|you have won|dial \*\d|unsubscribe|limited time offer|data bundle',
  caseSensitive: false,
);

final _loanWord = RegExp(r'\bloan\b', caseSensitive: false);
final _loanSignal = RegExp(
  r'\b(outstanding|amount due|due date|overdue)\b|\binstalments?\s+\d+\s+of\s+\d+\b|\bcleared\b|\bfully (?:paid|repaid)\b',
  caseSensitive: false,
);

/// Lender balance / due-date / instalment texts. Not a payment, an OTP, or a loan advert.
bool isLoanStatusBody(String body) => _loanWord.hasMatch(body) && _loanSignal.hasMatch(body);

bool isKnownBankSender(String sender) {
  final n = sender.trim().toLowerCase();
  return defaultBankSenders.any((id) => id.toLowerCase() == n);
}

bool isPersonalChatSender(String sender) {
  final stripped = sender.trim().replaceAll(RegExp(r'[\s()-]'), '');
  return _phone.hasMatch(stripped);
}

bool isBankStyleSender(String sender) {
  final n = sender.trim();
  if (n.length < 3 || n.length > 11) return false;
  if (RegExp(r'\s').hasMatch(n)) return false;
  if (!_letter.hasMatch(n)) return false;
  if (isPersonalChatSender(n) || isBlockedSender(n)) return false;
  return true;
}

SmsClassification classifyFinancialSms(String sender, String body) {
  final trimmed = sender.trim();
  if (trimmed.isEmpty) {
    return const SmsClassification(financial: false, score: 0, reason: 'low_score');
  }
  if (isPersonalChatSender(trimmed)) {
    return const SmsClassification(financial: false, score: 0, reason: 'personal');
  }
  if (isBlockedSender(trimmed)) {
    return const SmsClassification(financial: false, score: 0, reason: 'telco');
  }
  if (_otp.hasMatch(body)) {
    return const SmsClassification(financial: false, score: 0, reason: 'otp');
  }
  final currency = _currency.hasMatch(body);
  final direction = _direction.hasMatch(body);
  final balance = _balance.hasMatch(body);
  if (_promo.hasMatch(body) && !(currency && (direction || balance))) {
    return const SmsClassification(financial: false, score: 0, reason: 'promo');
  }
  if (isLoanStatusBody(body)) {
    return const SmsClassification(financial: true, score: financialScoreThreshold, reason: 'loan_status');
  }
  var score = 0;
  if (currency) score += 3;
  if (direction) score += 2;
  if (_txn.hasMatch(body)) score += 1;
  if (balance) score += 2;
  if (_masked.hasMatch(body)) score += 2;
  if (isBankStyleSender(trimmed)) score += 1;
  final financial = score >= financialScoreThreshold;
  return SmsClassification(
    financial: financial,
    score: score,
    reason: financial ? 'financial' : 'low_score',
  );
}

SenderAction senderAction(
  String sender,
  String body, {
  Set<String> approved = const {},
  Set<String> denied = const {},
}) {
  if (!classifyFinancialSms(sender, body).financial) return SenderAction.drop;
  final key = sender.trim().toLowerCase();
  if (isKnownBankSender(sender) || approved.contains(key)) return SenderAction.upload;
  if (denied.contains(key)) return SenderAction.drop;
  return SenderAction.ask;
}

bool shouldUploadSms(
  String sender,
  String body, {
  Set<String> approved = const {},
  Set<String> denied = const {},
}) {
  return senderAction(sender, body, approved: approved, denied: denied) ==
      SenderAction.upload;
}
