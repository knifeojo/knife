/// Bank SMS sender IDs. Personal numbers and telco/promo IDs are never read or uploaded.
const defaultBankSenders = ['GTBank', 'GTWorld', 'FirstBank', 'STERLING', 'Sterling', 'PROVIDUS'];

const defaultBlockedSenders = ['303', 'GloDataSale', 'GLO-ROAM', 'VIDEO', 'getmigo', 'MYD ALERT', 'MTN', 'Airtel', '9mobile', 'Glo'];

final _phone = RegExp(r'^\+?\d{8,15}$');

bool isPhoneSender(String sender) => _phone.hasMatch(sender.replaceAll(RegExp(r'[\s()-]'), ''));

bool isBlockedSender(String sender) {
  final n = sender.trim().toLowerCase();
  return defaultBlockedSenders.any((b) => b.toLowerCase() == n);
}

bool isAllowedSmsSender(String sender, {List<String> extra = const []}) {
  final n = sender.trim();
  if (n.isEmpty || isPhoneSender(n) || isBlockedSender(n)) return false;
  final allow = [...defaultBankSenders, ...extra].map((s) => s.toLowerCase());
  return allow.contains(n.toLowerCase());
}

bool isBankMarketing(String body) {
  final marketing = RegExp(r'congratulations! you have a loan offer|alwayson overdraft|keep transacting', caseSensitive: false);
  final txn = RegExp(r'\b(amt|amount|debit|credit|money (in|out)|you have spent|has arrived)\b', caseSensitive: false);
  return marketing.hasMatch(body) && !txn.hasMatch(body);
}
