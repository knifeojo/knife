class UserProfile {
  const UserProfile({required this.id, required this.email, this.name, required this.isDemo});

  final String id;
  final String email;
  final String? name;
  final bool isDemo;

  factory UserProfile.fromJson(Map<String, dynamic> json) {
    return UserProfile(
      id: _string(json, 'id'),
      email: _string(json, 'email'),
      name: _optionalString(json, 'name'),
      isDemo: json['isDemo'] == true,
    );
  }
}

class AuthSession {
  const AuthSession({required this.token, required this.expiresAt, required this.user});

  final String token;
  final DateTime expiresAt;
  final UserProfile user;

  factory AuthSession.fromJson(Map<String, dynamic> json) {
    return AuthSession(
      token: _string(json, 'token'),
      expiresAt: DateTime.parse(_string(json, 'expiresAt')),
      user: UserProfile.fromJson(_map(json, 'user')),
    );
  }
}

class LedgerAccount {
  const LedgerAccount({
    required this.id,
    required this.institution,
    required this.accountName,
    required this.maskedAccountNumber,
    this.holderName,
    required this.currency,
    this.balanceMinor,
    this.balanceUpdatedAt,
  });

  final String id;
  final String institution;
  final String accountName;
  final String maskedAccountNumber;
  final String? holderName;
  final String currency;
  final String? balanceMinor;
  final DateTime? balanceUpdatedAt;

  factory LedgerAccount.fromJson(Map<String, dynamic> json) {
    final updated = _optionalString(json, 'balanceUpdatedAt');
    return LedgerAccount(
      id: _string(json, 'id'),
      institution: _string(json, 'institution'),
      accountName: _string(json, 'accountName'),
      maskedAccountNumber: _string(json, 'maskedAccountNumber'),
      holderName: _optionalString(json, 'holderName'),
      currency: _string(json, 'currency'),
      balanceMinor: _optionalMinor(json, 'balanceMinor'),
      balanceUpdatedAt: updated == null ? null : DateTime.parse(updated),
    );
  }
}

class AccountList {
  const AccountList({required this.accounts, required this.totalBaseMinor, required this.totalBaseCurrency});

  final List<LedgerAccount> accounts;
  final String totalBaseMinor;
  final String totalBaseCurrency;

  factory AccountList.fromJson(Map<String, dynamic> json) {
    return AccountList(
      accounts: _list(json, 'accounts').map(LedgerAccount.fromJson).toList(),
      totalBaseMinor: _minor(json, 'totalBaseMinor'),
      totalBaseCurrency: _string(json, 'totalBaseCurrency'),
    );
  }
}

class LedgerTransaction {
  const LedgerTransaction({
    required this.id,
    required this.accountId,
    this.accountName,
    this.institution,
    this.maskedAccountNumber,
    required this.transactionDate,
    required this.type,
    required this.amountMinor,
    required this.currency,
    required this.description,
    this.merchantName,
    this.counterparty,
    required this.category,
    this.subcategory,
  });

  final String id;
  final String accountId;
  final String? accountName;
  final String? institution;
  final String? maskedAccountNumber;
  final DateTime transactionDate;
  final String type;
  final String amountMinor;
  final String currency;
  final String description;
  final String? merchantName;
  final String? counterparty;
  final String category;
  final String? subcategory;

  String get title {
    final merchant = merchantName?.trim();
    if (merchant != null && merchant.isNotEmpty) return merchant;
    final person = counterparty?.trim();
    if (person != null && person.isNotEmpty) return person;
    return description;
  }

  factory LedgerTransaction.fromJson(Map<String, dynamic> json) {
    return LedgerTransaction(
      id: _string(json, 'id'),
      accountId: _string(json, 'accountId'),
      accountName: _optionalString(json, 'accountName'),
      institution: _optionalString(json, 'institution'),
      maskedAccountNumber: _optionalString(json, 'maskedAccountNumber'),
      transactionDate: DateTime.parse(_string(json, 'transactionDate')),
      type: _string(json, 'type'),
      amountMinor: _minor(json, 'amountMinor'),
      currency: _string(json, 'currency'),
      description: _string(json, 'description'),
      merchantName: _optionalString(json, 'merchantName'),
      counterparty: _optionalString(json, 'counterparty'),
      category: _string(json, 'category'),
      subcategory: _optionalString(json, 'subcategory'),
    );
  }
}

class TransactionPage {
  const TransactionPage({
    required this.transactions,
    required this.total,
    required this.page,
    required this.pageSize,
    required this.categories,
  });

  final List<LedgerTransaction> transactions;
  final int total;
  final int page;
  final int pageSize;
  final List<String> categories;

  factory TransactionPage.fromJson(Map<String, dynamic> json) {
    return TransactionPage(
      transactions: _list(json, 'transactions').map(LedgerTransaction.fromJson).toList(),
      total: _int(json, 'total'),
      page: _int(json, 'page'),
      pageSize: _int(json, 'pageSize'),
      categories: _stringList(json, 'categories'),
    );
  }
}

class CategorySpend {
  const CategorySpend({required this.category, required this.totalMinor, required this.count});

  final String category;
  final String totalMinor;
  final int count;

  factory CategorySpend.fromJson(Map<String, dynamic> json) {
    return CategorySpend(category: _string(json, 'category'), totalMinor: _minor(json, 'totalMinor'), count: _int(json, 'count'));
  }
}

class HomeSummary {
  const HomeSummary({
    required this.periodLabel,
    required this.incomeMinor,
    required this.expensesMinor,
    required this.netMinor,
    required this.balanceMinor,
    required this.balanceCurrency,
    required this.count,
    required this.spending,
    required this.recent,
  });

  final String periodLabel;
  final String incomeMinor;
  final String expensesMinor;
  final String netMinor;
  final String balanceMinor;
  final String balanceCurrency;
  final int count;
  final List<CategorySpend> spending;
  final List<LedgerTransaction> recent;

  factory HomeSummary.fromJson(Map<String, dynamic> json) {
    final period = _map(json, 'period');
    return HomeSummary(
      periodLabel: _string(period, 'label'),
      incomeMinor: _minor(json, 'incomeMinor'),
      expensesMinor: _minor(json, 'expensesMinor'),
      netMinor: _minor(json, 'netMinor'),
      balanceMinor: _minor(json, 'balanceMinor'),
      balanceCurrency: _string(json, 'balanceCurrency'),
      count: _int(json, 'count'),
      spending: _list(json, 'spendingByCategory').map(CategorySpend.fromJson).toList(),
      recent: _list(json, 'recent').map(LedgerTransaction.fromJson).toList(),
    );
  }
}

class StatementImport {
  const StatementImport({
    required this.institution,
    required this.currency,
    required this.rowsRead,
    required this.created,
    required this.duplicates,
    required this.accountLast4,
    required this.balanceBreaks,
    required this.gap,
    required this.complete,
    required this.others,
  });

  final String institution;
  final String currency;
  final int rowsRead;
  final int created;
  final int duplicates;
  final String? accountLast4;
  final int balanceBreaks;
  final String? gap;
  final bool complete;
  final List<StatementImport> others;

  factory StatementImport.fromJson(Map<String, dynamic> json) {
    return StatementImport(
      institution: _string(json, 'institution'),
      currency: _string(json, 'currency'),
      rowsRead: _int(json, 'rowsRead'),
      created: _int(json, 'created'),
      duplicates: _int(json, 'duplicates'),
      accountLast4: _optionalString(json, 'accountLast4'),
      balanceBreaks: _int(json, 'balanceBreaks'),
      gap: _optionalString(json, 'gap'),
      complete: json['complete'] == true,
      others: (json['others'] as List<dynamic>?)?.map((item) => StatementImport.fromJson(_asMap(item))).toList() ?? const [],
    );
  }
}

class StatementFileResult {
  const StatementFileResult({required this.file, this.error, this.ok});

  final String file;
  final String? error;
  final StatementImport? ok;

  factory StatementFileResult.fromJson(Map<String, dynamic> json) {
    final ok = json['ok'];
    return StatementFileResult(
      file: _string(json, 'file'),
      error: _optionalString(json, 'error'),
      ok: ok is Map ? StatementImport.fromJson(_asMap(ok)) : null,
    );
  }

  String describe() {
    final imported = ok;
    if (imported == null) return '$file: ${error ?? 'Could not read this file.'}';
    final suffix = imported.accountLast4 == null ? '' : ' ••${imported.accountLast4}';
    final extra = imported.complete ? '' : ' Some rows need a look on the web app.';
    final more = imported.others.isEmpty ? '' : ' Also read ${imported.others.length} more account${imported.others.length == 1 ? '' : 's'} in this file.';
    return '${imported.institution}$suffix: ${imported.created} new, ${imported.duplicates} already imported.$extra$more';
  }
}

class ApiException implements Exception {
  const ApiException(this.status, this.message);

  final int status;
  final String message;

  @override
  String toString() => message;
}

String _string(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is String) return value;
  throw FormatException('Expected $key to be a string');
}

String? _optionalString(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value == null) return null;
  if (value is String) return value;
  throw FormatException('Expected $key to be a string');
}

String _minor(Map<String, dynamic> json, String key) {
  final value = _string(json, key);
  if (!RegExp(r'^-?\d+$').hasMatch(value)) throw FormatException('Expected $key to be minor units');
  return value;
}

String? _optionalMinor(Map<String, dynamic> json, String key) {
  if (json[key] == null) return null;
  return _minor(json, key);
}

int _int(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is int) return value;
  throw FormatException('Expected $key to be an integer');
}

Map<String, dynamic> _map(Map<String, dynamic> json, String key) => _asMap(json[key]);

Map<String, dynamic> _asMap(Object? value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return value.map((key, item) => MapEntry(key.toString(), item));
  throw const FormatException('Expected an object');
}

List<Map<String, dynamic>> _list(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! List) throw FormatException('Expected $key to be a list');
  return value.map(_asMap).toList();
}

List<String> _stringList(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! List || value.any((item) => item is! String)) throw FormatException('Expected $key to be strings');
  return value.cast<String>();
}
