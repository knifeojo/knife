import 'dart:convert';

import '../storage/settings_store.dart';

class QueuedSms {
  const QueuedSms({required this.sender, required this.body, required this.receivedAt, this.sourceId, this.attempts = 0});

  final String sender;
  final String body;
  final DateTime receivedAt;
  final String? sourceId;
  final int attempts;

  Map<String, Object?> toJson() => {
    'sender': sender,
    'body': body,
    'receivedAt': receivedAt.toIso8601String(),
    'sourceId': sourceId,
    'attempts': attempts,
  };

  factory QueuedSms.fromJson(Map<String, dynamic> json) {
    return QueuedSms(
      sender: json['sender'] as String,
      body: json['body'] as String,
      receivedAt: DateTime.parse(json['receivedAt'] as String),
      sourceId: json['sourceId'] as String?,
      attempts: (json['attempts'] as num?)?.toInt() ?? 0,
    );
  }

  QueuedSms retried() => QueuedSms(sender: sender, body: body, receivedAt: receivedAt, sourceId: sourceId, attempts: attempts + 1);
}

/// Offline outbox. Survives until Tailscale can reach the Ledger server.
class SmsOutbox {
  SmsOutbox(this.store);

  static const storageKey = 'sms_outbox';

  final SettingsStore store;
  final List<QueuedSms> _items = [];
  bool _loaded = false;

  List<QueuedSms> get items => List.unmodifiable(_items);

  Future<void> load() async {
    if (_loaded) return;
    final raw = await store.getString(storageKey);
    if (raw != null && raw.isNotEmpty) {
      final list = jsonDecode(raw);
      if (list is List) {
        _items
          ..clear()
          ..addAll(list.whereType<Map>().map((e) => QueuedSms.fromJson(Map<String, dynamic>.from(e))));
      }
    }
    _loaded = true;
  }

  Future<void> enqueue(QueuedSms sms) async {
    await load();
    _items.add(sms);
    await _persist();
  }

  Future<void> enqueueAll(List<QueuedSms> items) async {
    if (items.isEmpty) return;
    await load();
    _items.addAll(items);
    await _persist();
  }

  Future<void> removeAt(int index) async {
    _items.removeAt(index);
    await _persist();
  }

  Future<void> removeSourceIds(Set<String> ids) async {
    if (ids.isEmpty) return;
    await load();
    final before = _items.length;
    _items.removeWhere((item) => item.sourceId != null && ids.contains(item.sourceId));
    if (_items.length != before) await _persist();
  }

  Future<void> markRetried(String sourceId) async {
    await load();
    final index = _items.indexWhere((item) => item.sourceId == sourceId);
    if (index < 0) return;
    _items[index] = _items[index].retried();
    await _persist();
  }

  Future<void> replace(int index, QueuedSms sms) async {
    _items[index] = sms;
    await _persist();
  }

  Future<void> replaceAll(List<QueuedSms> items) async {
    await load();
    _items
      ..clear()
      ..addAll(items);
    await _persist();
  }

  Future<void> _persist() async {
    await store.setString(storageKey, jsonEncode(_items.map((e) => e.toJson()).toList()));
  }
}
