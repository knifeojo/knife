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
    this.cadence,
    this.recurringBill = false,
  });

  static const cadences = ['recurring', 'one_off'];

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

  /// `recurring`, `one_off`, or null for everyday spend and rows the server did not label.
  final String? cadence;

  /// A recurring payment Afford counts as a bill to keep paying.
  final bool recurringBill;

  /// Chip text for the cadence, matching the web app.
  String? get cadenceLabel {
    if (cadence == 'recurring') return recurringBill ? 'Recurring bill' : 'Recurring';
    if (cadence == 'one_off') return 'One-off';
    return null;
  }

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
      // Older servers send no cadence; unknown values are dropped rather than failing the list.
      cadence: cadences.contains(json['cadence']) ? json['cadence'] as String : null,
      recurringBill: json['recurringBill'] == true,
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
  const CategorySpend({
    required this.category,
    required this.totalMinor,
    required this.count,
    this.recurringMinor = '0',
    this.oneOffMinor = '0',
  });

  final String category;
  final String totalMinor;
  final int count;
  final String recurringMinor;
  final String oneOffMinor;

  factory CategorySpend.fromJson(Map<String, dynamic> json) {
    return CategorySpend(
      category: _string(json, 'category'),
      totalMinor: _minor(json, 'totalMinor'),
      count: _int(json, 'count'),
      recurringMinor: _optionalMinor(json, 'recurringMinor') ?? '0',
      oneOffMinor: _optionalMinor(json, 'oneOffMinor') ?? '0',
    );
  }
}

/// A big single payment this period, picked with Afford's one-off rules.
class SpendingOneOff {
  const SpendingOneOff({required this.id, required this.name, required this.category, this.subcategory, required this.amountMinor, required this.date});

  final String id;
  final String name;
  final String category;
  final String? subcategory;
  final String amountMinor;
  final DateTime date;

  factory SpendingOneOff.fromJson(Map<String, dynamic> json) {
    return SpendingOneOff(
      id: _string(json, 'id'),
      name: _string(json, 'name'),
      category: _string(json, 'category'),
      subcategory: _optionalString(json, 'subcategory'),
      amountMinor: _minor(json, 'amountMinor'),
      date: DateTime.parse(_string(json, 'date')),
    );
  }
}

/// One line of the everyday breakdown: a category, or a person or business paid.
class EverydayGroup {
  const EverydayGroup({required this.name, required this.totalMinor, required this.count});

  final String name;
  final String totalMinor;
  final int count;

  factory EverydayGroup.fromJson(Map<String, dynamic> json) {
    return EverydayGroup(name: _string(json, 'name'), totalMinor: _minor(json, 'totalMinor'), count: _int(json, 'count'));
  }
}

/// Everyday spending (not recurring, not a one-off) by category and by person or business paid.
class EverydayBreakdown {
  const EverydayBreakdown({required this.totalMinor, required this.count, required this.byCategory, required this.byPayee});

  final String totalMinor;
  final int count;
  final List<EverydayGroup> byCategory;
  final List<EverydayGroup> byPayee;

  factory EverydayBreakdown.fromJson(Map<String, dynamic> json) {
    return EverydayBreakdown(
      totalMinor: _minor(json, 'totalMinor'),
      count: _int(json, 'count'),
      byCategory: _list(json, 'byCategory').map(EverydayGroup.fromJson).toList(),
      byPayee: _list(json, 'byPayee').map(EverydayGroup.fromJson).toList(),
    );
  }
}

/// Payments still on the default Transfers label: the bank recorded who was paid, not what for.
class UnlabelledSpend {
  const UnlabelledSpend({required this.count, required this.totalMinor, required this.needsReview, required this.reviewQuestions});

  final int count;
  final String totalMinor;

  /// They are a large share of the month's spending, so Review is worth suggesting.
  final bool needsReview;

  /// Review questions that would label them. 0 means label them from the transactions list instead.
  final int reviewQuestions;

  factory UnlabelledSpend.fromJson(Map<String, dynamic> json) {
    return UnlabelledSpend(
      count: _int(json, 'count'),
      totalMinor: _minor(json, 'totalMinor'),
      needsReview: json['needsReview'] == true,
      reviewQuestions: json['reviewQuestions'] is int ? json['reviewQuestions'] as int : 0,
    );
  }
}

/// The server's line for payments with no recognisable name; it is not a payee filter.
const unnamedPayee = 'Unnamed payments';

/// One person or business paid this period, every spelling of the name matched ("what I spent on").
class PayeeSpend {
  const PayeeSpend({
    required this.name,
    this.label,
    required this.category,
    required this.totalMinor,
    required this.count,
    required this.recurringMinor,
    required this.oneOffMinor,
    required this.everydayMinor,
    this.regular,
    required this.unlabelledMinor,
    required this.variants,
    required this.unnamed,
  });

  static const kinds = ['fixed', 'variable', 'frequent'];

  final String name;
  final String? label;
  final String category;
  final String totalMinor;
  final int count;
  final String recurringMinor;
  final String oneOffMinor;
  final String everydayMinor;

  /// fixed, variable or frequent when this payee is paid regularly, else null.
  final String? regular;

  /// Spent on this payee with no purpose yet.
  final String unlabelledMinor;

  /// Other spellings matched into this payee.
  final List<String> variants;

  /// The "Unnamed payments" line: rows with no recognisable name.
  final bool unnamed;

  factory PayeeSpend.fromJson(Map<String, dynamic> json) {
    final regular = json['regular'];
    return PayeeSpend(
      name: _string(json, 'name'),
      label: _optionalString(json, 'label'),
      category: _string(json, 'category'),
      totalMinor: _minor(json, 'totalMinor'),
      count: _int(json, 'count'),
      recurringMinor: _minor(json, 'recurringMinor'),
      oneOffMinor: _minor(json, 'oneOffMinor'),
      everydayMinor: _minor(json, 'everydayMinor'),
      regular: kinds.contains(regular) ? regular as String : null,
      unlabelledMinor: _minor(json, 'unlabelledMinor'),
      variants: _optionalStringList(json, 'variants'),
      unnamed: json['unnamed'] == true,
    );
  }
}

/// A regular payment found by matched payee name, as on the web Spending page.
class RecurringGroup {
  const RecurringGroup({
    required this.name,
    this.label,
    required this.category,
    required this.kind,
    required this.bill,
    required this.averageMinor,
    required this.occurrences,
    required this.months,
    required this.lastDate,
    required this.nextExpected,
    required this.aliases,
  });

  final String name;
  final String? label;
  final String category;

  /// fixed: monthly, similar amount. variable: monthly, amount varies. frequent: several times a month.
  final String kind;

  /// Afford counts it as a bill to keep paying.
  final bool bill;

  /// Typical payment; for a frequent payee, a typical month's total.
  final String averageMinor;
  final int occurrences;
  final int months;
  final DateTime lastDate;
  final DateTime nextExpected;
  final List<String> aliases;

  String get kindLabel => switch (kind) {
    'variable' => 'Monthly, amount varies',
    'frequent' => 'Several times a month',
    _ => 'Monthly',
  };

  factory RecurringGroup.fromJson(Map<String, dynamic> json) {
    final kind = _string(json, 'kind');
    return RecurringGroup(
      name: _string(json, 'name'),
      label: _optionalString(json, 'label'),
      category: _string(json, 'category'),
      kind: PayeeSpend.kinds.contains(kind) ? kind : 'fixed',
      bill: json['bill'] == true,
      averageMinor: _minor(json, 'averageMinor'),
      occurrences: _int(json, 'occurrences'),
      months: _int(json, 'months'),
      lastDate: DateTime.parse(_string(json, 'lastDate')),
      nextExpected: DateTime.parse(_string(json, 'nextExpected')),
      aliases: _optionalStringList(json, 'aliases'),
    );
  }
}

/// This period's spending split the way Afford sees it: bills, other recurring, one-offs, everyday.
class SpendingSplit {
  const SpendingSplit({
    required this.recurringBillsMinor,
    required this.recurringOtherMinor,
    required this.oneOffMinor,
    required this.everydayMinor,
    required this.oneOffMinMinor,
    required this.labelled,
    required this.oneOffs,
    this.everyday,
    this.payees = const [],
    this.unlabelled,
  });

  final String recurringBillsMinor;
  final String recurringOtherMinor;
  final String oneOffMinor;
  final String everydayMinor;
  final String oneOffMinMinor;

  /// False when the period is older than the six months Afford looks back over.
  final bool labelled;
  final List<SpendingOneOff> oneOffs;

  /// Null on servers that predate the everyday drill-down.
  final EverydayBreakdown? everyday;

  /// The month by matched person or business, biggest first. Empty on older servers.
  final List<PayeeSpend> payees;

  /// Null on servers that predate the Review prompt.
  final UnlabelledSpend? unlabelled;

  factory SpendingSplit.fromJson(Map<String, dynamic> json) {
    final everyday = json['everyday'];
    final unlabelled = json['unlabelled'];
    return SpendingSplit(
      recurringBillsMinor: _minor(json, 'recurringBillsMinor'),
      recurringOtherMinor: _minor(json, 'recurringOtherMinor'),
      oneOffMinor: _minor(json, 'oneOffMinor'),
      everydayMinor: _minor(json, 'everydayMinor'),
      oneOffMinMinor: _minor(json, 'oneOffMinMinor'),
      labelled: json['labelled'] != false,
      oneOffs: _optionalList(json, 'oneOffs').map(SpendingOneOff.fromJson).toList(),
      everyday: everyday == null ? null : EverydayBreakdown.fromJson(_asMap(everyday)),
      payees: _optionalList(json, 'payees').map(PayeeSpend.fromJson).toList(),
      unlabelled: unlabelled == null ? null : UnlabelledSpend.fromJson(_asMap(unlabelled)),
    );
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
    this.split,
    this.periodFrom,
    this.periodTo,
    this.recurring = const [],
  });

  final String periodLabel;

  /// Period bounds (to is exclusive). Null if the server left them out.
  final DateTime? periodFrom;
  final DateTime? periodTo;
  final String incomeMinor;
  final String expensesMinor;
  final String netMinor;
  final String balanceMinor;
  final String balanceCurrency;
  final int count;
  final List<CategorySpend> spending;
  final List<LedgerTransaction> recent;

  /// Null on servers that predate the recurring vs one-off split.
  final SpendingSplit? split;

  /// Regular payments by matched payee, debits only. Empty on older servers.
  final List<RecurringGroup> recurring;

  factory HomeSummary.fromJson(Map<String, dynamic> json) {
    final period = _map(json, 'period');
    final split = json['spendingSplit'];
    return HomeSummary(
      periodLabel: _string(period, 'label'),
      periodFrom: _optionalDate(period, 'from'),
      periodTo: _optionalDate(period, 'to'),
      incomeMinor: _minor(json, 'incomeMinor'),
      expensesMinor: _minor(json, 'expensesMinor'),
      netMinor: _minor(json, 'netMinor'),
      balanceMinor: _minor(json, 'balanceMinor'),
      balanceCurrency: _string(json, 'balanceCurrency'),
      count: _int(json, 'count'),
      spending: _list(json, 'spendingByCategory').map(CategorySpend.fromJson).toList(),
      recent: _list(json, 'recent').map(LedgerTransaction.fromJson).toList(),
      split: split == null ? null : SpendingSplit.fromJson(_asMap(split)),
      recurring: _optionalList(json, 'recurring').map(RecurringGroup.fromJson).toList(),
    );
  }
}

class ReviewOption {
  const ReviewOption({required this.value, required this.label, required this.category, this.subcategory});

  final String value;
  final String label;
  final String category;
  final String? subcategory;

  factory ReviewOption.fromJson(Map<String, dynamic> json) {
    return ReviewOption(
      value: _string(json, 'value'),
      label: _string(json, 'label'),
      category: _string(json, 'category'),
      subcategory: _optionalString(json, 'subcategory'),
    );
  }
}

/// Purpose words the bank narration already carries ("WARDROBE TO ACCESS - …"). Answered like "Other".
class NarrationHint {
  const NarrationHint({required this.words, required this.category, this.subcategory});

  final String words;
  final String category;
  final String? subcategory;

  factory NarrationHint.fromJson(Map<String, dynamic> json) {
    return NarrationHint(words: _string(json, 'words'), category: _string(json, 'category'), subcategory: _optionalString(json, 'subcategory'));
  }
}

/// What the AI proposed for a payee. Nothing changes until the owner confirms it in Review.
class AiSuggestion {
  const AiSuggestion({
    required this.id,
    required this.display,
    required this.direction,
    required this.category,
    this.subcategory,
    required this.reason,
    required this.confidence,
    required this.model,
    required this.count,
    required this.totalMinor,
    required this.currentCategory,
    required this.examples,
  });

  final String id;
  final String display;

  /// "in" or "out".
  final String direction;
  final String category;
  final String? subcategory;
  final String reason;
  final double confidence;
  final String model;
  final int count;
  final String totalMinor;
  final String currentCategory;
  final List<String> examples;

  String get label => subcategory == null ? category : '$category / $subcategory';

  factory AiSuggestion.fromJson(Map<String, dynamic> json) {
    final confidence = json['confidence'];
    if (confidence is! num) throw const FormatException('Expected confidence to be a number');
    return AiSuggestion(
      id: _string(json, 'id'),
      display: _string(json, 'display'),
      direction: _string(json, 'direction'),
      category: _string(json, 'category'),
      subcategory: _optionalString(json, 'subcategory'),
      reason: _optionalString(json, 'reason') ?? '',
      confidence: confidence.toDouble(),
      model: _optionalString(json, 'model') ?? 'AI',
      count: _int(json, 'count'),
      totalMinor: _minor(json, 'totalMinor'),
      currentCategory: _optionalString(json, 'currentCategory') ?? '',
      examples: _optionalStringList(json, 'examples'),
    );
  }
}

/// AI categorization on the server: which model, whether it answers, and whether it is on for this account.
class AiStatus {
  const AiStatus({
    required this.provider,
    required this.model,
    required this.cloud,
    required this.reachable,
    required this.modelInstalled,
    required this.message,
    required this.enabled,
    required this.available,
    required this.pendingSuggestions,
    required this.backlog,
  });

  /// "ollama", "anthropic" or "off".
  final String provider;
  final String model;
  final bool cloud;
  final bool reachable;
  final bool modelInstalled;
  final String message;
  final bool enabled;

  /// False when the server has AI off; the toggle cannot be switched on.
  final bool available;
  final int pendingSuggestions;
  final int backlog;

  bool get ready => reachable && modelInstalled;

  String get providerLabel => switch (provider) {
    'ollama' => 'Ollama (on the server’s machine)',
    'anthropic' => 'Anthropic (cloud)',
    _ => 'Off',
  };

  factory AiStatus.fromJson(Map<String, dynamic> json) {
    return AiStatus(
      provider: _string(json, 'provider'),
      model: _optionalString(json, 'model') ?? '',
      cloud: json['cloud'] == true,
      reachable: json['reachable'] == true,
      modelInstalled: json['modelInstalled'] == true,
      message: _optionalString(json, 'message') ?? '',
      enabled: json['enabled'] == true,
      available: json['available'] != false,
      pendingSuggestions: _optionalInt(json, 'pendingSuggestions') ?? 0,
      backlog: _optionalInt(json, 'backlog') ?? 0,
    );
  }
}

/// One "Help Ledger get this right" question, the same as the web Review page.
class ReviewQuestion {
  const ReviewQuestion({
    required this.kind,
    required this.key,
    required this.title,
    required this.prompt,
    required this.totalMinor,
    required this.count,
    required this.examples,
    required this.options,
    this.currentCategory,
    this.hint,
    required this.narrationHints,
    required this.allowsOther,
    this.aiSuggestion,
  });

  final String kind;
  final String key;
  final String title;
  final String prompt;
  final String totalMinor;
  final int count;

  /// Full bank narrations of sample payments, never shortened.
  final List<String> examples;
  final List<ReviewOption> options;
  final String? currentCategory;
  final String? hint;
  final List<NarrationHint> narrationHints;
  final bool allowsOther;

  /// The AI's pick for this payee, shown pre-selected. Null on servers without AI.
  final AiSuggestion? aiSuggestion;

  factory ReviewQuestion.fromJson(Map<String, dynamic> json) {
    return ReviewQuestion(
      kind: _string(json, 'kind'),
      key: _string(json, 'key'),
      title: _string(json, 'title'),
      prompt: _string(json, 'prompt'),
      totalMinor: _minor(json, 'totalMinor'),
      count: _int(json, 'count'),
      examples: _optionalStringList(json, 'examples'),
      options: _list(json, 'options').map(ReviewOption.fromJson).toList(),
      currentCategory: _optionalString(json, 'currentCategory'),
      hint: _optionalString(json, 'hint'),
      narrationHints: _optionalList(json, 'narrationHints').map(NarrationHint.fromJson).toList(),
      allowsOther: json['allowsOther'] != false,
      aiSuggestion: json['aiSuggestion'] == null ? null : AiSuggestion.fromJson(_map(json, 'aiSuggestion')),
    );
  }
}

class ReviewQueue {
  const ReviewQueue({required this.questions, required this.totalMinor, required this.categories, this.suggestions = const []});

  final List<ReviewQuestion> questions;
  final String totalMinor;
  final List<String> categories;

  /// AI suggestions for payees no question covers.
  final List<AiSuggestion> suggestions;

  factory ReviewQueue.fromJson(Map<String, dynamic> json) {
    return ReviewQueue(
      questions: _list(json, 'questions').map(ReviewQuestion.fromJson).toList(),
      totalMinor: _minor(json, 'totalMinor'),
      categories: _stringList(json, 'categories'),
      suggestions: _optionalList(json, 'suggestions').map(AiSuggestion.fromJson).toList(),
    );
  }
}

/// Answer from "Re-run categorization".
class CategorizeResult {
  const CategorizeResult({required this.checked, required this.changed, required this.message});

  final int checked;
  final int changed;
  final String message;

  factory CategorizeResult.fromJson(Map<String, dynamic> json) {
    return CategorizeResult(checked: _int(json, 'checked'), changed: _int(json, 'changed'), message: _string(json, 'message'));
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

class AffordabilityObligation {
  const AffordabilityObligation({
    required this.name,
    required this.category,
    this.label,
    required this.monthlyMinor,
    required this.dueInWindowMinor,
    this.nextDue,
    this.kind = 'recurring',
  });

  final String name;
  final String category;
  final String? label;
  final String monthlyMinor;
  final String dueInWindowMinor;
  final DateTime? nextDue;
  final String kind; // recurring

  factory AffordabilityObligation.fromJson(Map<String, dynamic> json) {
    return AffordabilityObligation(
      name: _string(json, 'name'),
      category: _string(json, 'category'),
      label: _optionalString(json, 'label'),
      monthlyMinor: _minor(json, 'monthlyMinor'),
      dueInWindowMinor: _minor(json, 'dueInWindowMinor'),
      nextDue: _optionalDate(json, 'nextDue'),
      kind: _optionalString(json, 'kind') ?? 'recurring',
    );
  }
}

/// A big single payment outside any regular stream. Already in past spending, not a recurring bill.
class AffordabilityOneOff {
  const AffordabilityOneOff({required this.name, required this.category, this.label, required this.amountMinor, required this.date});

  final String name;
  final String category;
  final String? label;
  final String amountMinor;
  final DateTime date;

  factory AffordabilityOneOff.fromJson(Map<String, dynamic> json) {
    return AffordabilityOneOff(
      name: _string(json, 'name'),
      category: _string(json, 'category'),
      label: _optionalString(json, 'label'),
      amountMinor: _minor(json, 'amountMinor'),
      date: DateTime.parse(_string(json, 'date')),
    );
  }
}

/// One rule-based next step from the server, built from the user's ledger.
class AffordabilityAdvice {
  const AffordabilityAdvice({required this.kind, required this.text, this.subject, this.monthlyMinor, this.openMinor, this.loan});

  static const kinds = ['debt', 'cut', 'one_off', 'none'];

  final String kind; // debt | cut | one_off | none
  final String text;
  final String? subject;
  final String? monthlyMinor;
  final String? openMinor;

  /// Set when the user entered this loan, so [openMinor] is their real balance. Older servers never send it.
  final AdviceLoan? loan;

  factory AffordabilityAdvice.fromJson(Map<String, dynamic> json) {
    final kind = _string(json, 'kind');
    if (!kinds.contains(kind)) throw FormatException('Unknown advice kind $kind');
    return AffordabilityAdvice(
      kind: kind,
      text: _string(json, 'text'),
      subject: _optionalString(json, 'subject'),
      monthlyMinor: _optionalMinor(json, 'monthlyMinor'),
      openMinor: _optionalMinor(json, 'openMinor'),
      loan: json['loan'] == null ? null : AdviceLoan.fromJson(_map(json, 'loan')),
    );
  }
}

/// The loan behind a debt line, as the user entered it.
class AdviceLoan {
  const AdviceLoan({
    required this.id,
    required this.outstandingMinor,
    required this.balanceAsOf,
    this.endsOn,
    this.instalmentsLeft,
    this.repaymentsSince = 0,
    this.repaidSinceMinor = '0',
  });

  final String id;
  final String outstandingMinor;
  final DateTime balanceAsOf;
  final DateTime? endsOn;
  final int? instalmentsLeft;

  /// Repayments the bank shows since the balance was entered. Above 0 means it is out of date.
  final int repaymentsSince;
  final String repaidSinceMinor;

  factory AdviceLoan.fromJson(Map<String, dynamic> json) {
    return AdviceLoan(
      id: _string(json, 'id'),
      outstandingMinor: _minor(json, 'outstandingMinor'),
      balanceAsOf: DateTime.parse(_string(json, 'balanceAsOf')),
      endsOn: _optionalDate(json, 'endsOn'),
      instalmentsLeft: _optionalInt(json, 'instalmentsLeft'),
      repaymentsSince: _optionalInt(json, 'repaymentsSince') ?? 0,
      repaidSinceMinor: _optionalMinor(json, 'repaidSinceMinor') ?? '0',
    );
  }
}

/// A loan the user typed in from their lender's app, from `/api/v1/loans`. Dates are calendar days at 00:00 UTC.
class LedgerLoan {
  const LedgerLoan({
    required this.id,
    required this.lender,
    required this.outstandingMinor,
    this.instalmentMinor,
    this.instalmentsPaid,
    this.instalmentsTotal,
    this.instalmentsLeft,
    this.nextDueDate,
    this.endDate,
    this.payoffDate,
    this.notes,
    required this.status,
    required this.balanceAsOf,
    this.closedAt,
    this.repaymentsSince = 0,
    this.repaidSinceMinor = '0',
    this.lastRepaymentSince,
  });

  final String id;
  final String lender;
  final String outstandingMinor;
  final String? instalmentMinor;
  final int? instalmentsPaid;
  final int? instalmentsTotal;
  final int? instalmentsLeft;
  final DateTime? nextDueDate;
  final DateTime? endDate;

  /// The end date, or one the server worked out from the instalments left.
  final DateTime? payoffDate;
  final String? notes;
  final String status; // open | closed
  final DateTime balanceAsOf;
  final DateTime? closedAt;
  final int repaymentsSince;
  final String repaidSinceMinor;
  final DateTime? lastRepaymentSince;

  bool get isOpen => status != 'closed';

  factory LedgerLoan.fromJson(Map<String, dynamic> json) {
    final since = json['repaymentsSince'] == null ? const <String, dynamic>{} : _map(json, 'repaymentsSince');
    return LedgerLoan(
      id: _string(json, 'id'),
      lender: _string(json, 'lender'),
      outstandingMinor: _minor(json, 'outstandingMinor'),
      instalmentMinor: _optionalMinor(json, 'instalmentMinor'),
      instalmentsPaid: _optionalInt(json, 'instalmentsPaid'),
      instalmentsTotal: _optionalInt(json, 'instalmentsTotal'),
      instalmentsLeft: _optionalInt(json, 'instalmentsLeft'),
      nextDueDate: _optionalDate(json, 'nextDueDate'),
      endDate: _optionalDate(json, 'endDate'),
      payoffDate: _optionalDate(json, 'payoffDate'),
      notes: _optionalString(json, 'notes'),
      status: _optionalString(json, 'status') ?? 'open',
      balanceAsOf: DateTime.parse(_string(json, 'balanceAsOf')),
      closedAt: _optionalDate(json, 'closedAt'),
      repaymentsSince: _optionalInt(since, 'count') ?? 0,
      repaidSinceMinor: _optionalMinor(since, 'totalMinor') ?? '0',
      lastRepaymentSince: _optionalDate(since, 'lastDate'),
    );
  }
}

class LoanList {
  const LoanList({required this.loans, required this.lenders});

  final List<LedgerLoan> loans;

  /// The lender names a loan can be filed under, the same ones the server's lender detection uses.
  final List<String> lenders;

  factory LoanList.fromJson(Map<String, dynamic> json) {
    return LoanList(loans: _list(json, 'loans').map(LedgerLoan.fromJson).toList(), lenders: _stringList(json, 'lenders'));
  }
}

/// What the loan form sends. Kobo as strings, days as YYYY-MM-DD.
class LoanDraft {
  const LoanDraft({
    required this.lender,
    required this.outstandingMinor,
    this.instalmentMinor,
    this.instalmentsPaid,
    this.instalmentsTotal,
    this.nextDueDate,
    this.endDate,
    this.notes,
  });

  final String lender;
  final String outstandingMinor;
  final String? instalmentMinor;
  final int? instalmentsPaid;
  final int? instalmentsTotal;
  final String? nextDueDate;
  final String? endDate;
  final String? notes;

  Map<String, Object?> toJson() => {
    'lender': lender,
    'outstandingMinor': outstandingMinor,
    'instalmentMinor': instalmentMinor,
    'instalmentsPaid': instalmentsPaid,
    'instalmentsTotal': instalmentsTotal,
    'nextDueDate': nextDueDate,
    'endDate': endDate,
    'notes': notes,
  };
}

/// Answer from `POST /api/v1/affordability`. Every amount stays a minor-unit string.
class AffordabilityCheck {
  const AffordabilityCheck({
    required this.verdict,
    required this.headline,
    required this.detail,
    required this.notes,
    required this.amountMinor,
    this.description,
    required this.windowFrom,
    required this.windowTo,
    required this.cashMinor,
    required this.cashKnown,
    this.cashAsOf,
    required this.monthlyIncomeMinor,
    required this.incomeMonths,
    required this.monthlyObligationsMinor,
    required this.obligations,
    required this.otherLoanRepaymentsMinor,
    required this.monthlyEverydayMinor,
    required this.monthlySurplusMinor,
    required this.bufferMinor,
    required this.bufferRule,
    required this.incomeInMinor,
    required this.incomeRule,
    required this.obligationsOutMinor,
    required this.everydayOutMinor,
    required this.lowestMinor,
    required this.lowestOn,
    required this.headroomMinor,
    this.monthsToSave,
    this.advice = const [],
    this.oneOffs = const [],
    this.oneOffsTotalMinor = '0',
    this.oneOffMinMinor = '0',
    this.oneOffsSince,
  });

  final String verdict; // yes | stretch | no
  final String headline;
  final List<String> detail;
  final List<String> notes;
  final String amountMinor;
  final String? description;
  final DateTime windowFrom;
  final DateTime windowTo;
  final String cashMinor;
  final bool cashKnown;
  final DateTime? cashAsOf;
  final String monthlyIncomeMinor;
  final List<String> incomeMonths;
  final String monthlyObligationsMinor;
  final List<AffordabilityObligation> obligations;
  final String otherLoanRepaymentsMinor;
  final String monthlyEverydayMinor;
  final String monthlySurplusMinor;
  final String bufferMinor;
  final String bufferRule; // obligations | floor | yours
  final String incomeInMinor;
  final String incomeRule; // paydays | monthly | none
  final String obligationsOutMinor;
  final String everydayOutMinor;
  final String lowestMinor;
  final DateTime lowestOn;
  final String headroomMinor;
  final int? monthsToSave;
  final List<AffordabilityAdvice> advice;
  final List<AffordabilityOneOff> oneOffs;
  final String oneOffsTotalMinor;
  final String oneOffMinMinor;
  final DateTime? oneOffsSince;

  factory AffordabilityCheck.fromJson(Map<String, dynamic> json) {
    final window = _map(json, 'window');
    final inputs = _map(json, 'inputs');
    final projection = _map(json, 'projection');
    final verdict = _string(json, 'verdict');
    if (!const ['yes', 'stretch', 'no'].contains(verdict)) throw const FormatException('Expected verdict to be yes, stretch or no');
    final months = json['monthsToSave'];
    if (months != null && months is! int) throw const FormatException('Expected monthsToSave to be an integer');
    return AffordabilityCheck(
      verdict: verdict,
      headline: _string(json, 'headline'),
      detail: _stringList(json, 'detail'),
      notes: _stringList(json, 'notes'),
      amountMinor: _minor(json, 'amountMinor'),
      description: _optionalString(json, 'description'),
      windowFrom: DateTime.parse(_string(window, 'from')),
      windowTo: DateTime.parse(_string(window, 'to')),
      cashMinor: _minor(inputs, 'cashMinor'),
      cashKnown: inputs['cashKnown'] == true,
      cashAsOf: _optionalDate(inputs, 'cashAsOf'),
      monthlyIncomeMinor: _minor(inputs, 'monthlyIncomeMinor'),
      incomeMonths: _stringList(inputs, 'incomeMonths'),
      monthlyObligationsMinor: _minor(inputs, 'monthlyObligationsMinor'),
      obligations: _list(inputs, 'obligations').map(AffordabilityObligation.fromJson).toList(),
      otherLoanRepaymentsMinor: _minor(inputs, 'otherLoanRepaymentsMinor'),
      monthlyEverydayMinor: _minor(inputs, 'monthlyEverydayMinor'),
      monthlySurplusMinor: _minor(inputs, 'monthlySurplusMinor'),
      bufferMinor: _minor(inputs, 'bufferMinor'),
      bufferRule: _string(inputs, 'bufferRule'),
      incomeInMinor: _minor(projection, 'incomeInMinor'),
      incomeRule: _string(projection, 'incomeRule'),
      obligationsOutMinor: _minor(projection, 'obligationsOutMinor'),
      everydayOutMinor: _minor(projection, 'everydayOutMinor'),
      lowestMinor: _minor(projection, 'lowestMinor'),
      lowestOn: DateTime.parse(_string(projection, 'lowestOn')),
      headroomMinor: _minor(projection, 'headroomMinor'),
      monthsToSave: months as int?,
      // Older servers send no advice or one-offs; the answer still reads without them.
      advice: _optionalList(json, 'advice').map(AffordabilityAdvice.fromJson).toList(),
      oneOffs: _optionalList(inputs, 'oneOffs').map(AffordabilityOneOff.fromJson).toList(),
      oneOffsTotalMinor: _optionalMinor(inputs, 'oneOffsTotalMinor') ?? '0',
      oneOffMinMinor: _optionalMinor(inputs, 'oneOffMinMinor') ?? '0',
      oneOffsSince: _optionalDate(inputs, 'oneOffsSince'),
    );
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

DateTime? _optionalDate(Map<String, dynamic> json, String key) {
  final value = _optionalString(json, key);
  return value == null ? null : DateTime.parse(value);
}

int _int(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is int) return value;
  throw FormatException('Expected $key to be an integer');
}

int? _optionalInt(Map<String, dynamic> json, String key) => json[key] == null ? null : _int(json, key);

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

List<Map<String, dynamic>> _optionalList(Map<String, dynamic> json, String key) => json[key] == null ? const [] : _list(json, key);

List<String> _stringList(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! List || value.any((item) => item is! String)) throw FormatException('Expected $key to be strings');
  return value.cast<String>();
}

List<String> _optionalStringList(Map<String, dynamic> json, String key) => json[key] == null ? const [] : _stringList(json, key);
