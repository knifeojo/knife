import '../api/models.dart';

class AskFreedLoan {
  const AskFreedLoan({required this.lender, required this.freedPerMonthMinor});

  final String lender;
  final String freedPerMonthMinor;

  factory AskFreedLoan.fromJson(Map<String, dynamic> json) {
    return AskFreedLoan(lender: '${json['lender'] ?? ''}', freedPerMonthMinor: '${json['freedPerMonthMinor'] ?? '0'}');
  }
}

class AskMessage {
  const AskMessage({
    required this.id,
    required this.role,
    required this.text,
    this.mode,
    this.affordability,
    this.freedLoans = const [],
    this.keepAtLeastMinor,
  });

  final String id;
  final String role;
  final String text;
  final String? mode;
  final AffordabilityCheck? affordability;
  final List<AskFreedLoan> freedLoans;
  final String? keepAtLeastMinor;

  bool get fromUser => role == 'user';

  factory AskMessage.fromJson(Map<String, dynamic> json) {
    final card = json['card'];
    final cardMap = card is Map ? Map<String, dynamic>.from(card) : null;
    final afford = cardMap?['affordability'];
    final freed = cardMap?['freedLoans'];
    return AskMessage(
      id: '${json['id'] ?? ''}',
      role: '${json['role'] ?? 'assistant'}',
      text: '${json['text'] ?? ''}',
      mode: json['mode'] as String?,
      affordability: afford is Map ? AffordabilityCheck.fromJson(Map<String, dynamic>.from(afford)) : null,
      freedLoans: freed is List
          ? [
              for (final row in freed)
                if (row is Map) AskFreedLoan.fromJson(Map<String, dynamic>.from(row)),
            ]
          : const [],
      keepAtLeastMinor: cardMap?['keepAtLeastMinor'] as String?,
    );
  }
}
